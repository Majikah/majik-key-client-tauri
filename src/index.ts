export {
  DEFAULT_EVENT_CHANNEL,
  DEFAULT_PLUGIN,
  MajikKeyClientTauri,
  type MajikKeyClientTauriOptions,
  type UnlockHandler,
} from "./client.js";
export { MajikKeyClientError, isUnlockRequired, type ClientErrorKind } from "./errors.js";
export { createTauriTransport, type Transport } from "./transport.js";
export type * from "./types.js";
