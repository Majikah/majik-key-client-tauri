import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listenMock(...a) }));

import { MajikKeyClientTauri, MajikKeyClientError, createTauriTransport } from "../src/index.js";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("createTauriTransport", () => {
  it("prefixes commands with plugin:<name>| and passes args through", async () => {
    invokeMock.mockResolvedValue(42);
    const t = createTauriTransport("majik-key-client");
    expect(await t.invoke("do_it", { a: 1 })).toBe(42);
    expect(invokeMock).toHaveBeenCalledWith("plugin:majik-key-client|do_it", { a: 1 });
  });

  it("wraps Tauri's rejected {kind,message} objects in MajikKeyClientError", async () => {
    invokeMock.mockRejectedValue({ kind: "duplicateAccount", message: "Account with the same ID already exists" });
    const t = createTauriTransport("p");
    const err = await t.invoke("x").catch((e) => e);
    expect(err).toBeInstanceOf(MajikKeyClientError);
    expect(err).toMatchObject({ kind: "duplicateAccount", command: "x" });
  });

  it("wraps a string rejection as a transport error", async () => {
    invokeMock.mockRejectedValue("Command foo not found");
    const err = await createTauriTransport("p").invoke("foo").catch((e) => e);
    expect(err).toMatchObject({ kind: "transport", message: "Command foo not found" });
  });

  it("listen unwraps the Tauri event payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_event: string, cb: (e: { payload: unknown }) => void) => {
      cb({ payload: { type: "lock", payload: "a" } });
      return unlisten;
    });
    const got: unknown[] = [];
    const stop = await createTauriTransport("p").listen("chan", (p) => got.push(p));
    expect(listenMock.mock.calls[0]?.[0]).toBe("chan");
    expect(got).toEqual([{ type: "lock", payload: "a" }]);
    expect(stop).toBe(unlisten);
  });
});

describe("a different plugin name reuses the same facade", () => {
  it("routes every command through the configured plugin", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith("|open_session")) return { report: null, snapshot: { accounts: [], activeAccountId: null, status: [] } };
      if (cmd.endsWith("|get_snapshot")) return { accounts: [], activeAccountId: null, status: [] };
      return undefined;
    });
    listenMock.mockResolvedValue(() => {});
    const c = await MajikKeyClientTauri.open({ plugin: "majik-signature-client", eventChannel: "majik-signature-client:event" });
    await c.lockAllAccounts();
    expect(invokeMock.mock.calls.map((x) => x[0])).toEqual([
      "plugin:majik-signature-client|open_session",
      "plugin:majik-signature-client|lock_all_accounts",
      "plugin:majik-signature-client|get_snapshot",
    ]);
    expect(listenMock.mock.calls[0]?.[0]).toBe("majik-signature-client:event");
  });
});
