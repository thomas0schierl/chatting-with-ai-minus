/**
 * Debug logging to `debug.log` in the plugin folder: the agent loop's
 * requests and errors, and the voice session's data-channel events. Off
 * unless `DEBUG` is set to true here; never logs keys or tokens.
 */
import type { App } from "obsidian";
import { PLUGIN_ID } from "./plugin-id";

const DEBUG = false;

export function debugLog(app: App, label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write into the current vault config folder.
    void app.vault.adapter.append(
      `${app.vault.configDir}/plugins/${PLUGIN_ID}/debug.log`,
      entry
    );
  } catch {
    // Debug logging should never break the app
  }
}
