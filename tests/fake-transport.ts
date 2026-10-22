import type { Transport } from "../src/transport.js";
import type { ClientEventEnvelope, Snapshot } from "../src/types.js";
import { MajikKeyClientError, type ClientErrorKind } from "../src/errors.js";

export interface RecordedCall {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

type Handler = (args: Record<string, unknown> | undefined) => unknown | Promise<unknown>;

export const EMPTY: Snapshot = { accounts: [], activeAccountId: null, status: [] };

export function contactFor(id: string, label = id) {
  return {
    id,
    fingerprint: id,
    meta: { label },
    publicKeyBase64: "cHVi",
    mlKey: "bWw=",
  };
}

/** A stand-in for the Rust side: records every call and answers from `handlers`. */
export class FakeTransport implements Transport {
  calls: RecordedCall[] = [];
  snapshot: Snapshot = EMPTY;
  handlers: Record<string, Handler> = {};
  private eventHandler: ((payload: never) => void) | null = null;
  listenedChannel: string | null = null;
  unlistened = false;
  /** Set to delay every `get_snapshot` response (ms) to exercise coalescing. */
  snapshotDelayMs = 0;

  constructor() {
    this.handlers["open_session"] = () => ({ report: null, snapshot: this.snapshot });
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ cmd: command, args });
    if (command === "get_snapshot") {
      if (this.snapshotDelayMs) await new Promise((r) => setTimeout(r, this.snapshotDelayMs));
      return structuredClone(this.snapshot) as T;
    }
    const h = this.handlers[command];
    if (!h) return undefined as T;
    return (await h(args)) as T;
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    this.listenedChannel = event;
    this.eventHandler = handler as unknown as (payload: never) => void;
    return () => {
      this.unlistened = true;
      this.eventHandler = null;
    };
  }

  emit(envelope: ClientEventEnvelope): void {
    (this.eventHandler as unknown as (e: ClientEventEnvelope) => void)?.(envelope);
  }

  fail(command: string, kind: ClientErrorKind, message: string = kind): void {
    this.handlers[command] = () => {
      throw new MajikKeyClientError(kind, message, command);
    };
  }

  count(cmd: string): number {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }
}
