import { describe, expect, it, vi } from "vitest";

import { MajikKeyClientTauri, MajikKeyClientError, isUnlockRequired } from "../src/index.js";
import { contactFor, FakeTransport } from "./fake-transport.js";

function snapshotWith(ids: string[], unlocked: string[] = ids) {
  return {
    accounts: ids.map((id) => contactFor(id)),
    activeAccountId: ids[0] ?? null,
    status: ids.map((id) => ({ id, unlocked: unlocked.includes(id), canSign: true })),
  };
}

async function open(t: FakeTransport, extra: ConstructorParameters<typeof MajikKeyClientTauri>[0] = {}) {
  return MajikKeyClientTauri.open({ transport: t, ...extra });
}

describe("open / read-model", () => {
  it("listens before opening the session, then serves synchronous getters from the snapshot", async () => {
    const t = new FakeTransport();
    t.snapshot = snapshotWith(["a", "b"], ["a"]);
    t.handlers["open_session"] = () => ({ report: { keysLoaded: 2, keysSkipped: [], accountsFailed: [] }, snapshot: t.snapshot });
    const c = await open(t);

    expect(t.listenedChannel).toBe("majik-key-client:event");
    expect(c.lastHydrateReport?.keysLoaded).toBe(2);
    expect(c.getActiveAccount()?.id).toBe("a");
    expect(c.getActiveAccountId()).toBe("a");
    expect(c.listOwnAccounts().map((a) => a.id)).toEqual(["a", "b"]);
    expect(c.getOwnAccountById("b")?.id).toBe("b");
    expect(c.getOwnAccountById("zzz")).toBeNull();
    expect(c.isAccountActive("a")).toBe(true);
    expect(c.isAccountUnlocked("a")).toBe(true);
    expect(c.isAccountUnlocked("b")).toBe(false);
    expect(c.hasSigningCapability()).toBe(true);
    expect(c.hasSigningCapability("b")).toBe(true);
    expect(c.hasSigningCapability("nope")).toBe(false);
  });

  it("an empty session has no active account and no signing capability", async () => {
    const c = await open(new FakeTransport());
    expect(c.getActiveAccount()).toBeNull();
    expect(c.hasSigningCapability()).toBe(false);
  });

  it("stops listening if the session fails to open", async () => {
    const t = new FakeTransport();
    t.fail("open_session", "storage", "db locked");
    await expect(open(t)).rejects.toMatchObject({ kind: "storage" });
    expect(t.unlistened).toBe(true);
  });
});

describe("mutations refresh the read-model before resolving", () => {
  it("createAccount: the new account is visible to synchronous getters on return", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    t.handlers["create_account"] = () => {
      t.snapshot = snapshotWith(["new"]);
      return { id: "new", fingerprint: "new", backup: "bk" };
    };
    const created = await c.createAccount({ mnemonic: "m", passphrase: "p" });
    expect(created.id).toBe("new");
    expect(c.getActiveAccount()?.id).toBe("new");
  });

  it("concurrent refreshes are coalesced but each caller still sees a fresh snapshot", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    t.snapshotDelayMs = 20;
    const before = t.count("get_snapshot");
    t.snapshot = snapshotWith(["x"]);
    const first = c.refresh();
    t.snapshot = snapshotWith(["y"]); // changes while the first read is in flight
    const second = c.refresh();
    await Promise.all([first, second]);
    expect(c.getActiveAccount()?.id).toBe("y");
    expect(t.count("get_snapshot") - before).toBeLessThanOrEqual(2);
  });
});

describe("events", () => {
  it("dispatches in order, each after the snapshot refresh", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    const seen: string[] = [];
    c.on("new-account", (acct) => seen.push(`new:${acct.id}:active=${c.getActiveAccountId()}`));
    c.on("lock", (id) => seen.push(`lock:${id}`));

    t.snapshot = snapshotWith(["a"]);
    t.emit({ type: "new-account", payload: contactFor("a") });
    t.emit({ type: "lock", payload: "a" });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    // The listener read the NEW snapshot synchronously.
    expect(seen).toEqual(["new:a:active=a", "lock:a"]);
  });

  it("off() and the returned unsubscribe stop delivery; a throwing listener does not break others", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = vi.fn();
    const b = vi.fn();
    c.on("unlock", () => {
      throw new Error("boom");
    });
    const stop = c.on("unlock", a);
    c.on("unlock", b);

    t.emit({ type: "unlock", payload: "x" });
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    expect(a).toHaveBeenCalledWith("x");
    expect(err).toHaveBeenCalled();

    stop();
    t.emit({ type: "unlock", payload: "y" });
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(2));
    expect(a).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("delivers the restore-backup event, which has no payload", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    const fn = vi.fn();
    c.on("restore-backup", fn);
    t.emit({ type: "restore-backup" });
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledWith(undefined);
  });
});

describe("unlock prompting (replaces window.prompt / promptFn)", () => {
  it("ensureIdentityUnlocked rethrows unlockRequired when there is no handler", async () => {
    const t = new FakeTransport();
    t.fail("ensure_identity_unlocked", "unlockRequired");
    const c = await open(t);
    const err = await c.ensureIdentityUnlocked("a").catch((e) => e);
    expect(isUnlockRequired(err)).toBe(true);
  });

  it("asks the handler for a passphrase, unlocks, and resolves", async () => {
    const t = new FakeTransport();
    t.fail("ensure_identity_unlocked", "unlockRequired");
    const handler = vi.fn(async () => "pw");
    const c = await open(t, { onUnlockRequested: handler });
    await c.ensureIdentityUnlocked("a");
    expect(handler).toHaveBeenCalledWith("a");
    expect(t.calls.find((x) => x.cmd === "unlock_account")?.args).toEqual({ id: "a", passphrase: "pw" });
  });

  it("a declined prompt rejects with kind=cancelled and never calls unlock", async () => {
    const t = new FakeTransport();
    t.fail("ensure_identity_unlocked", "unlockRequired");
    const c = await open(t, { onUnlockRequested: async () => null });
    await expect(c.ensureIdentityUnlocked("a")).rejects.toMatchObject({ kind: "cancelled" });
    expect(t.count("unlock_account")).toBe(0);
  });

  it("other errors are not treated as 'needs unlock'", async () => {
    const t = new FakeTransport();
    t.fail("ensure_identity_unlocked", "accountNotFound");
    const handler = vi.fn();
    const c = await open(t, { onUnlockRequested: handler });
    await expect(c.ensureIdentityUnlocked("a")).rejects.toMatchObject({ kind: "accountNotFound" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("setActiveAccount prompts for a locked account, then activates; resolves false if cancelled", async () => {
    const t = new FakeTransport();
    t.snapshot = snapshotWith(["a", "b"], ["a"]);
    t.fail("ensure_identity_unlocked", "unlockRequired");
    t.handlers["set_active_account"] = () => true;
    const handler = vi.fn(async () => "pw");
    const c = await open(t, { onUnlockRequested: handler });

    expect(await c.setActiveAccount("b")).toBe(true);
    expect(handler).toHaveBeenCalledWith("b");
    expect(t.calls.find((x) => x.cmd === "set_active_account")?.args).toEqual({ id: "b", bypassIdentity: false });

    const t2 = new FakeTransport();
    t2.snapshot = snapshotWith(["a", "b"], ["a"]);
    t2.fail("ensure_identity_unlocked", "unlockRequired");
    const c2 = await open(t2, { onUnlockRequested: async () => undefined });
    expect(await c2.setActiveAccount("b")).toBe(false);
    expect(t2.count("set_active_account")).toBe(0);
  });

  it("bypassIdentity skips the prompt entirely", async () => {
    const t = new FakeTransport();
    t.snapshot = snapshotWith(["a"], []);
    const handler = vi.fn();
    const c = await open(t, { onUnlockRequested: handler });
    await c.setActiveAccount("a", true);
    expect(handler).not.toHaveBeenCalled();
    expect(t.calls.find((x) => x.cmd === "set_active_account")?.args).toEqual({ id: "a", bypassIdentity: true });
  });
});

describe("errors and lifecycle", () => {
  it("normalises {kind,message}, strings and Errors", () => {
    expect(MajikKeyClientError.from({ kind: "invalid", message: "m" }, "cmd")).toMatchObject({ kind: "invalid", message: "m", command: "cmd" });
    expect(MajikKeyClientError.from("plain").kind).toBe("transport");
    expect(MajikKeyClientError.from(new Error("e")).message).toBe("e");
    const own = new MajikKeyClientError("storage", "x");
    expect(MajikKeyClientError.from(own)).toBe(own);
  });

  it("dispose unsubscribes and drops listeners; lockOnDispose locks first", async () => {
    const t = new FakeTransport();
    const c = await open(t, { lockOnDispose: true });
    const fn = vi.fn();
    c.on("lock", fn);
    await c.dispose();
    expect(t.count("lock_all_accounts")).toBe(1);
    expect(t.unlistened).toBe(true);
    await c.dispose(); // idempotent
    expect(t.count("lock_all_accounts")).toBe(1);
  });

  it("omits undefined options instead of sending null", async () => {
    const t = new FakeTransport();
    const c = await open(t);
    await c.createAccount({ mnemonic: "m", passphrase: "p", label: undefined as unknown as string });
    const sent = t.calls.find((x) => x.cmd === "create_account")?.args as { args: Record<string, unknown> };
    expect("label" in sent.args).toBe(false);
  });

  it("a subclass can reuse the facade and add commands via invoke/mutate", async () => {
    class SigLike extends MajikKeyClientTauri {
      signThing(id: string): Promise<string> {
        return this.invoke<string>("sign_thing", { id });
      }
    }
    const t = new FakeTransport();
    t.handlers["sign_thing"] = () => "sig";
    const c = await SigLike.open({ transport: t });
    expect(c).toBeInstanceOf(SigLike);
    expect(await c.signThing("a")).toBe("sig");
  });
});
