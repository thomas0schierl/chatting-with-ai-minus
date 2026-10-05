/**
 * Debug logging to `debug.log` in the plugin folder: the agent loop's
 * requests, errors and resends, the foreground/background hints, and the
 * voice session's data-channel events. Off unless the "Debug log" setting
 * is on (`setDebugLogging`); never logs keys or tokens, but does log the
 * user's messages. "Copy debug log" gets it off a phone.
 */
import type { App } from "obsidian";
import { PLUGIN_ID } from "./plugin-id";

let enabled = false;

/** Follows the "Debug log" setting. */
export function setDebugLogging(on: boolean): void {
  enabled = on;
}

function debugLogPath(app: App): string {
  return `${app.vault.configDir}/plugins/${PLUGIN_ID}/debug.log`;
}

export function debugLog(app: App, label: string, data: unknown): void {
  if (!enabled) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write into the current vault config folder.
    void app.vault.adapter.append(debugLogPath(app), entry);
  } catch {
    // Debug logging should never break the app
  }
}

/** The log's text; empty when there is none. */
export async function readDebugLog(app: App): Promise<string> {
  const path = debugLogPath(app);
  try {
    return await app.vault.adapter.exists(path) ? await app.vault.adapter.read(path) : "";
  } catch {
    return "";
  }
}

export async function clearDebugLog(app: App): Promise<void> {
  const path = debugLogPath(app);
  if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
}
