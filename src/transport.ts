import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { MajikKeyClientError } from "./errors.js";

/**
 * The only thing this package needs from Tauri. Injectable so tests can fake Rust, and so another
 * plugin (e.g. the signature client's) can reuse the same facade under its own plugin name.
 */
export interface Transport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/** `plugin` is the Tauri plugin name, e.g. `"majik-key-client"` -> `plugin:majik-key-client|cmd`. */
export function createTauriTransport(plugin: string): Transport {
  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      try {
        return await invoke<T>(`plugin:${plugin}|${command}`, args);
      } catch (err) {
        throw MajikKeyClientError.from(err, command);
      }
    },
    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      return listen<T>(event, (e) => handler(e.payload));
    },
  };
}
