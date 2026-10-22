import { MajikKeyClientError, isUnlockRequired } from "./errors.js";
import { createTauriTransport, type Transport } from "./transport.js";
import type {
  AccountStatus,
  BackupAccountOptions,
  ClientEventEnvelope,
  ClientEventMap,
  ClientEventType,
  CreateAccountOptions,
  CreatedAccount,
  HydrateReport,
  ImportedAccount,
  MajikKeyJson,
  MigrationSummary,
  MnemonicLanguage,
  OpenedSession,
  ReplacePassphraseOptions,
  SerializedIdentity,
  SerializedMajikContact,
  Snapshot,
  StateEntry,
  UpdatePassphraseOptions,
} from "./types.js";

export const DEFAULT_PLUGIN = "majik-key-client";
export const DEFAULT_EVENT_CHANNEL = "majik-key-client:event";

/**
 * Called when an operation needs an unlocked account. Resolve with the passphrase, or with
 * `null`/`undefined` if the user cancelled. Replaces the old `window.prompt` / `promptFn` flow:
 * Rust never prompts.
 */
export type UnlockHandler = (
  accountId: string,
) => Promise<string | null | undefined>;

export interface MajikKeyClientTauriOptions {
  /** Tauri plugin name. Default `"majik-key-client"`. */
  plugin?: string;
  /** Replace the Tauri transport (tests, or a different plugin). Overrides `plugin`. */
  transport?: Transport;
  /** Event channel Rust emits on. Default `"majik-key-client:event"`. */
  eventChannel?: string;
  onUnlockRequested?: UnlockHandler;
  /** Lock every account when `dispose()` is called. */
  lockOnDispose?: boolean;
}

type AnyListener = (payload: unknown) => void;

const EMPTY_SNAPSHOT: Snapshot = {
  accounts: [],
  activeAccountId: null,
  status: [],
};

/** Drop `undefined` values: serde treats a missing key and `null` differently from "unset". */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

/**
 * TypeScript facade over `tauri-plugin-majik-key-client`.
 *
 * All keys and account state live in Rust. This class keeps a small **read-model** (a `Snapshot`
 * of the account list, active account and lock states) so the familiar synchronous getters keep
 * working in React; every mutation and every Rust event refreshes it.
 *
 * Create with `await MajikKeyClientTauri.open()`. Subclasses (e.g. a signature client) call
 * `super` helpers `invoke`/`mutate` and can point `plugin` at their own Tauri plugin.
 */
export class MajikKeyClientTauri {
  protected readonly transport: Transport;
  protected readonly options: MajikKeyClientTauriOptions;

  private snapshot: Snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Map<ClientEventType, Set<AnyListener>>();
  private unlistenEvents: (() => void) | null = null;
  private eventChain: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;

  /** Set by `open()` when this call hydrated the Rust client (null if it was already open). */
  lastHydrateReport: HydrateReport | null = null;

  constructor(options: MajikKeyClientTauriOptions = {}) {
    this.options = options;
    this.transport =
      options.transport ??
      createTauriTransport(options.plugin ?? DEFAULT_PLUGIN);
  }

  /** Subscribe to events, open the Rust session (hydrating once) and load the first snapshot. */
  static async open<C extends MajikKeyClientTauri>(
    this: new (options: MajikKeyClientTauriOptions) => C,
    options: MajikKeyClientTauriOptions = {},
  ): Promise<C> {
    const client = new this(options);
    await client.initialize();
    return client;
  }

  protected async initialize(): Promise<OpenedSession> {
    // Listen first so no event emitted during the session open can be missed.
    this.unlistenEvents = await this.transport.listen<ClientEventEnvelope>(
      this.options.eventChannel ?? DEFAULT_EVENT_CHANNEL,
      (envelope) => this.enqueueEvent(envelope),
    );
    try {
      const opened = await this.invoke<OpenedSession>("open_session");
      this.snapshot = opened.snapshot;
      this.lastHydrateReport = opened.report;
      return opened;
    } catch (err) {
      this.unlistenEvents();
      this.unlistenEvents = null;
      throw err;
    }
  }

  // ── Subclass helpers ───────────────────────────────────────────────────────

  protected invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    return this.transport.invoke<T>(command, args);
  }

  /** `invoke`, then refresh the read-model so the caller sees consistent synchronous getters. */
  protected async mutate<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.invoke<T>(command, args);
    await this.refresh();
    return result;
  }

  // ── Read-model ─────────────────────────────────────────────────────────────

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  /** Re-read the snapshot from Rust. Concurrent calls are coalesced; the returned promise
   *  resolves only after a snapshot at least as new as the call has been applied. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.dirty = false;
        this.snapshot = await this.invoke<Snapshot>("get_snapshot");
      } while (this.dirty);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  getActiveAccount(): SerializedMajikContact | null {
    return this.snapshot.accounts[0] ?? null;
  }

  getActiveAccountId(): string | null {
    return this.snapshot.activeAccountId;
  }

  getOwnAccountById(id: string): SerializedMajikContact | null {
    return this.snapshot.accounts.find((a) => a.id === id) ?? null;
  }

  /** Accounts in order; the first is the active account. */
  listOwnAccounts(): SerializedMajikContact[] {
    return this.snapshot.accounts;
  }

  isAccountActive(id: string): boolean {
    return this.snapshot.activeAccountId === id;
  }

  getAccountStatus(id: string): AccountStatus | null {
    return this.snapshot.status.find((s) => s.id === id) ?? null;
  }

  isAccountUnlocked(id: string): boolean {
    return this.getAccountStatus(id)?.unlocked ?? false;
  }

  /** Reads the snapshot; pass no id for the active account. */
  hasSigningCapability(id?: string): boolean {
    const target = id ?? this.snapshot.activeAccountId;
    if (target === null) return false;
    return this.getAccountStatus(target)?.canSign ?? false;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  on<K extends ClientEventType>(
    type: K,
    listener: (payload: ClientEventMap[K]) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as AnyListener);
    return () => this.off(type, listener);
  }

  off<K extends ClientEventType>(
    type: K,
    listener: (payload: ClientEventMap[K]) => void,
  ): void {
    this.listeners.get(type)?.delete(listener as AnyListener);
  }

  /** Events are processed in order, each after the snapshot has been refreshed, so a listener
   *  that reads the synchronous getters always sees state at least as new as the event. */
  private enqueueEvent(envelope: ClientEventEnvelope): void {
    this.eventChain = this.eventChain.then(async () => {
      if (this.disposed) return;
      try {
        await this.refresh();
      } catch {
        // Keep serving the last good snapshot; the event is still delivered.
      }
      this.dispatch(envelope);
    });
  }

  private dispatch(envelope: ClientEventEnvelope): void {
    const set = this.listeners.get(envelope.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(envelope.payload);
      } catch (err) {
        console.error(
          `[majik-key-client] listener for "${envelope.type}" threw`,
          err,
        );
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Reload everything from storage. **This re-locks every key.** `open()` already hydrates once. */
  hydrate(): Promise<HydrateReport> {
    return this.mutate<HydrateReport>("hydrate");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.options.lockOnDispose) {
      try {
        await this.invoke<void>("lock_all_accounts");
      } catch {
        // Best effort: Rust also locks everything on app exit.
      }
    }
    this.disposed = true;
    this.unlistenEvents?.();
    this.unlistenEvents = null;
    this.listeners.clear();
  }

  resetData(): Promise<void> {
    return this.mutate<void>("reset_data");
  }

  // ── Mnemonic & accounts ────────────────────────────────────────────────────

  generateMnemonic(
    strength: 128 | 256 = 128,
    language?: MnemonicLanguage,
  ): Promise<string> {
    return this.invoke<string>(
      "generate_mnemonic",
      compact({ strength, language }),
    );
  }

  createAccount(options: CreateAccountOptions): Promise<CreatedAccount> {
    return this.mutate<CreatedAccount>("create_account", {
      args: compact({ ...options }),
    });
  }

  importAccountFromMnemonicBackup(
    options: BackupAccountOptions,
  ): Promise<ImportedAccount> {
    return this.mutate<ImportedAccount>("import_account_from_mnemonic_backup", {
      args: compact({ ...options }),
    });
  }

  /** Swap the active account for the one in `backup` (or refresh it if it is the same account). */
  replaceAccountFromMnemonicBackup(
    options: BackupAccountOptions,
  ): Promise<ImportedAccount> {
    return this.mutate<ImportedAccount>(
      "replace_account_from_mnemonic_backup",
      {
        args: compact({ ...options }),
      },
    );
  }

  /** The account must be unlocked. */
  exportAccountMnemonicBackup(id: string, mnemonic: string): Promise<string> {
    return this.invoke<string>("export_account_mnemonic_backup", {
      id,
      mnemonic,
    });
  }

  addOwnAccount(account: SerializedMajikContact): Promise<void> {
    return this.mutate<void>("add_own_account", { account });
  }

  removeOwnAccount(id: string): Promise<boolean> {
    return this.mutate<boolean>("remove_own_account", { id });
  }

  updateAccountLabel(id: string, label: string): Promise<void> {
    return this.mutate<void>("update_account_label", { id, label });
  }

  /**
   * Make `id` the active account. Unless `bypassIdentity` is set the account must be unlocked; if
   * it is locked and an `onUnlockRequested` handler exists, the user is asked for the passphrase
   * first. Resolves `false` (never throws for "locked") when the account could not be activated.
   */
  async setActiveAccount(id: string, bypassIdentity = false): Promise<boolean> {
    if (
      !bypassIdentity &&
      this.options.onUnlockRequested &&
      !this.isAccountUnlocked(id)
    ) {
      if (this.getOwnAccountById(id)) {
        try {
          await this.ensureIdentityUnlocked(id);
        } catch {
          return false;
        }
      }
    }
    return this.mutate<boolean>("set_active_account", { id, bypassIdentity });
  }

  // ── Lock / unlock / passphrase ─────────────────────────────────────────────

  unlockAccount(id: string, passphrase: string): Promise<void> {
    return this.mutate<void>("unlock_account", { id, passphrase });
  }

  lockAccount(id: string): Promise<void> {
    return this.mutate<void>("lock_account", { id });
  }

  lockAllAccounts(): Promise<void> {
    return this.mutate<void>("lock_all_accounts");
  }

  verifyPassphrase(id: string, passphrase: string): Promise<boolean> {
    return this.invoke<boolean>("verify_passphrase", { id, passphrase });
  }

  /** Verify against `id`, or the active account when omitted. */
  isPassphraseValid(passphrase: string, id?: string): Promise<boolean> {
    return this.invoke<boolean>(
      "is_passphrase_valid",
      compact({ passphrase, id }),
    );
  }

  updatePassphrase(options: UpdatePassphraseOptions): Promise<void> {
    return this.mutate<void>("update_passphrase", { args: { ...options } });
  }

  /** Recover an account from its backup + mnemonic under a new passphrase. Resolves the id. */
  replacePassphrase(options: ReplacePassphraseOptions): Promise<string> {
    return this.mutate<string>("replace_passphrase", {
      args: compact({ ...options }),
    });
  }

  /**
   * Resolves if the account is unlocked. If it is locked, asks `onUnlockRequested` for the
   * passphrase and unlocks it; rejects with `unlockRequired` when there is no handler, or with
   * `cancelled` when the user declines.
   */
  async ensureIdentityUnlocked(id: string): Promise<void> {
    try {
      await this.invoke<void>("ensure_identity_unlocked", { id });
      return;
    } catch (err) {
      if (!isUnlockRequired(err)) throw err;
      const handler = this.options.onUnlockRequested;
      if (!handler) throw err;
      const passphrase = await handler(id);
      if (
        passphrase === null ||
        passphrase === undefined ||
        passphrase === ""
      ) {
        throw new MajikKeyClientError(
          "cancelled",
          "Unlock cancelled",
          "ensure_identity_unlocked",
        );
      }
      await this.unlockAccount(id, passphrase);
    }
  }

  // ── Client state (generic key/value; higher-level clients keep preferences here) ──

  getState(key: string): Promise<string | null> {
    return this.invoke<string | null>("state_get", { key });
  }

  setState(key: string, value: string): Promise<void> {
    return this.invoke<void>("state_set", { key, value });
  }

  removeState(key: string): Promise<boolean> {
    return this.invoke<boolean>("state_remove", { key });
  }

  listState(): Promise<StateEntry[]> {
    return this.invoke<StateEntry[]>("state_list");
  }

  // ── Keystore backup / migration ────────────────────────────────────────────

  /** Stored rows: encrypted key material only. */
  exportKeystore(): Promise<MajikKeyJson[]> {
    return this.invoke<MajikKeyJson[]>("keystore_export");
  }

  /** Replace the keystore with `keys`. Restored accounts come back locked. */
  restoreKeystore(keys: MajikKeyJson[]): Promise<HydrateReport> {
    return this.mutate<HydrateReport>("keystore_restore", { keys });
  }

  migrateLegacyIdentities(
    identities: SerializedIdentity[],
  ): Promise<MigrationSummary> {
    return this.mutate<MigrationSummary>("migrate_legacy_identities", {
      identities,
    });
  }
}
