/** Every Rust error crosses IPC as `{ kind, message }`. */
export type ClientErrorKind =
  | "key"
  | "contact"
  | "storage"
  | "accountNotFound"
  | "duplicateAccount"
  | "unlockRequired"
  | "invalid"
  | "reset"
  /** Raised by this layer (transport failures, cancelled unlock prompts). */
  | "transport"
  | "cancelled";

export class MajikKeyClientError extends Error {
  readonly kind: ClientErrorKind;
  readonly command: string | undefined;

  constructor(kind: ClientErrorKind, message: string, command?: string) {
    super(message);
    this.name = "MajikKeyClientError";
    this.kind = kind;
    this.command = command;
  }

  /** Normalise whatever `invoke` rejected with. */
  static from(err: unknown, command?: string): MajikKeyClientError {
    if (err instanceof MajikKeyClientError) return err;
    if (typeof err === "object" && err !== null) {
      const o = err as { kind?: unknown; message?: unknown };
      if (typeof o.kind === "string" && typeof o.message === "string") {
        return new MajikKeyClientError(
          o.kind as ClientErrorKind,
          o.message,
          command,
        );
      }
    }
    const message =
      typeof err === "string"
        ? err
        : err instanceof Error
          ? err.message
          : String(err);
    return new MajikKeyClientError("transport", message, command);
  }
}

export function isUnlockRequired(err: unknown): boolean {
  return err instanceof MajikKeyClientError && err.kind === "unlockRequired";
}
