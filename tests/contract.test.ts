import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MajikKeyClientTauri } from "../src/index.js";
import { FakeTransport, contactFor } from "./fake-transport.js";

/**
 * Replays contract/scenario.json: for every step the TS facade must send exactly the recorded
 * `cmd` + `args`. The Rust plugin test replays the same file against a real client, so a change
 * on either side that breaks the wire format fails one of the two suites.
 */
interface Step {
  call: { method: string; params: unknown[] };
  cmd: string;
  args: unknown;
  expect: string;
  save?: Record<string, string>;
  rustOnly?: boolean;
}
const scenario = JSON.parse(
  readFileSync(new URL("../contract/scenario.json", import.meta.url), "utf8"),
) as { steps: Step[] };

/** Canned results from the fake "Rust" so later steps can reference `$vars`. */
const CANNED: Record<string, unknown> = {
  create_account: { id: "ID1", fingerprint: "ID1", backup: "BK" },
  export_account_mnemonic_backup: "BACKUP",
  keystore_export: [{ id: "ID1", fingerprint: "ID1", label: "", publicKey: "", salt: "", backup: "", timestamp: "" }],
};

function subst(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === "string" && v.startsWith("$")) return vars[v.slice(1)];
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)]));
  }
  return v;
}

function pick(result: unknown, path: string): unknown {
  if (path === "$") return result;
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], result);
}

class Probe extends MajikKeyClientTauri {
  raw<T>(cmd: string, args?: Record<string, unknown>) {
    return this.invoke<T>(cmd, args);
  }
}

describe("TS facade matches the wire contract", () => {
  it("sends exactly the contracted command + args for every step", async () => {
    const t = new FakeTransport();
    t.snapshot = { accounts: [contactFor("ID1")], activeAccountId: "ID1", status: [{ id: "ID1", unlocked: true, canSign: true }] };
    for (const [cmd, value] of Object.entries(CANNED)) t.handlers[cmd] = () => value;
    const c = await Probe.open({ transport: t });
    const vars: Record<string, unknown> = {};
    let checked = 0;

    for (const step of scenario.steps) {
      if (step.rustOnly) continue;
      const before = t.calls.length;
      const params = subst(step.call.params, vars) as unknown[];
      const m = step.call.method;
      const client = c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

      let result: unknown;
      switch (m) {
        case "openSessionRaw":
          result = await c.raw("open_session");
          break;
        case "ensureIdentityUnlockedRaw":
          result = await c.ensureIdentityUnlocked(params[0] as string);
          break;
        case "setActiveAccountRaw":
          result = await c.setActiveAccount(params[0] as string, params[1] as boolean);
          break;
        case "getSnapshotRaw":
          result = await c.refresh();
          break;
        default: {
          const fn = client[m];
          if (typeof fn !== "function") throw new Error(`facade has no method ${m} (step ${step.cmd})`);
          result = await fn.apply(c, params);
        }
      }

      const sent = t.calls.slice(before).filter((x) => step.cmd === "get_snapshot" || x.cmd !== "get_snapshot");
      const first = sent[0];
      expect(first?.cmd, `step ${m}`).toBe(step.cmd);
      expect(first?.args ?? {}, `step ${m} args`).toEqual(subst(step.args, vars));

      for (const [name, path] of Object.entries(step.save ?? {})) {
        vars[name] = step.cmd === "get_snapshot" ? pick(t.snapshot, path) : pick(CANNED[step.cmd] ?? result, path);
      }
      checked++;
    }
    expect(checked).toBe(scenario.steps.filter((s) => !s.rustOnly).length);
  });
});
