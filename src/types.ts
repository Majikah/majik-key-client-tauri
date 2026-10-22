/**
 * Wire types. These mirror the Rust DTOs in `majik_key_client::ipc` (camelCase JSON) and were
 * written from the real serialized output, not guessed.
 */

export type MnemonicLanguage =
  | "en" | "fr" | "es" | "it" | "ja" | "ko" | "czech" | "pt" | "zh-cn" | "zh-tw";

export interface MajikContactMeta {
  label?: string;
  notes?: string;
  blocked?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Any extra app-defined metadata (flattened by serde). */
  [extra: string]: unknown;
}

/** A `MajikContact` in its serialized form. Accounts are exposed as these. */
export interface SerializedMajikContact {
  id: string;
  fingerprint: string;
  meta?: MajikContactMeta;
  /** X25519 public key, base64. */
  publicKeyBase64: string;
  /** ML-KEM-768 public key, base64. */
  mlKey: string;
  /** Note the snake_case key: it is that way on the wire in the TS library too. */
  majikah_registered?: boolean;
  edPublicKeyBase64?: string;
  mlDsaPublicKeyBase64?: string;
}

/**
 * One stored key row (encrypted key material only). Treated as opaque: pass it back to
 * `restoreKeystore` unchanged.
 */
export interface MajikKeyJson {
  id: string;
  fingerprint: string;
  label: string;
  publicKey: string;
  salt: string;
  backup: string;
  timestamp: string;
  kdfVersion?: number;
  mnemonicLanguage?: MnemonicLanguage;
  [field: string]: unknown;
}

/** Pre-registry account record (X25519 only). */
export interface SerializedIdentity {
  id: string;
  publicKey: string;
  fingerprint: string;
  encryptedPrivateKey?: string;
  salt?: string;
}

export interface CreatedAccount {
  id: string;
  fingerprint: string;
  /** The encrypted mnemonic backup string. */
  backup: string;
}

export interface ImportedAccount {
  id: string;
  fingerprint: string;
}

export interface SkippedItem {
  id: string;
  reason: string;
}

export interface HydrateReport {
  keysLoaded: number;
  keysSkipped: SkippedItem[];
  accountsFailed: SkippedItem[];
}

export interface MigrationSummary {
  migrated: number;
  skipped: number;
  accountsFailed: SkippedItem[];
}

export interface AccountStatus {
  id: string;
  unlocked: boolean;
  /** Holds the Ed25519 + ML-DSA-87 signing keys (true for locked accounts too). */
  canSign: boolean;
}

/** Everything the synchronous getters read. `accounts[0]` is the active account. */
export interface Snapshot {
  accounts: SerializedMajikContact[];
  activeAccountId: string | null;
  status: AccountStatus[];
}

export interface OpenedSession {
  /** Present only for the call that actually hydrated the Rust client. */
  report: HydrateReport | null;
  snapshot: Snapshot;
}

export interface StateEntry {
  id: string;
  value: string;
}

// ─── Arguments ───────────────────────────────────────────────────────────────

export interface CreateAccountOptions {
  mnemonic: string;
  passphrase: string;
  label?: string;
  meta?: MajikContactMeta;
  /** Defaults to English. */
  language?: MnemonicLanguage;
}

export interface BackupAccountOptions {
  backup: string;
  mnemonic: string;
  passphrase: string;
  label?: string;
  meta?: MajikContactMeta;
  language?: MnemonicLanguage;
}

export interface ReplacePassphraseOptions {
  backup: string;
  mnemonic: string;
  newPassphrase: string;
  id: string;
  label?: string;
}

export interface UpdatePassphraseOptions {
  id: string;
  currentPassphrase: string;
  newPassphrase: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface ClientErrorEventPayload {
  message: string;
  context: string;
  id: string | null;
}

export interface ClientEventMap {
  "new-account": SerializedMajikContact;
  "removed-account": string;
  "updated-account": SerializedMajikContact;
  "active-account-change": {
    active: SerializedMajikContact | null;
    previous: string | null;
  };
  unlock: string;
  lock: string;
  error: ClientErrorEventPayload;
  "restore-backup": undefined;
}

export type ClientEventType = keyof ClientEventMap;

/** What Rust emits on the event channel. */
export type ClientEventEnvelope = {
  [K in ClientEventType]: { type: K; payload?: ClientEventMap[K] };
}[ClientEventType];
