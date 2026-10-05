/**
 * ChatGPT sign-in storage, backed by Obsidian's SecretStorage (OS keychain).
 *
 * Two records, both per device:
 * - Credential (`…-chatgpt-oauth`): tokens and the validated identity.
 *   Cleared on disconnect.
 * - Registration (`…-chatgpt-registration`): this device's host ID and the
 *   client ID OpenAI issued at first sign-in. Kept on disconnect, so a later
 *   sign-in reuses the registration instead of creating a new one.
 *
 * The host ID isn't a secret, but it must differ per device. `data.json`
 * syncs across devices (two devices would share one ID); SecretStorage
 * doesn't.
 */
import type { App } from "obsidian";
import { PLUGIN_ID } from "../plugin-id";

export interface ChatGPTOAuthCredential {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** Epoch ms when this record was last written. */
  updatedAt: number;
  /** Validated `sub` of the ID token: the account identity (catalog cache key). */
  accountId?: string;
  /** Email from the validated ID token, shown in settings. */
  email?: string;
  /** Scopes granted by the token endpoint. Missing in former Codex credentials. */
  scopes: string[];
  idToken?: string;
}

export interface ChatGPTRegistration {
  /** Stable `ext_agent_host_id` of this device (`urn:uuid:…`). */
  hostId: string;
  /** Client ID issued at first sign-in (`oaiapp_…`). */
  clientId?: string;
  /** Validated `sub` of the registered account. */
  subject?: string;
  /** Email of the registered account, sent as `login_hint`. */
  email?: string;
}

// SecretStorage IDs: lowercase alphanumeric with dashes.
const OAUTH_SECRET_KEY = `${PLUGIN_ID}-chatgpt-oauth`;
const REGISTRATION_SECRET_KEY = `${PLUGIN_ID}-chatgpt-registration`;
const EXPIRY_BUFFER_MS = 60_000;

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export class ChatGPTOAuthStore {
  constructor(private readonly app: App) {}

  /**
   * Read the stored credential. Returns null if absent or malformed. A
   * credential without `scopes` is from the former Codex sign-in and
   * doesn't work on this route, so it counts as not connected.
   */
  get(): ChatGPTOAuthCredential | null {
    const parsed = this.read(OAUTH_SECRET_KEY);
    if (
      !parsed ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      !Array.isArray(parsed.scopes)
    ) {
      return null;
    }
    const scopes = parsed.scopes.filter((s): s is string => typeof s === "string");
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      updatedAt: parsed.updatedAt,
      ...(str(parsed.accountId) ? { accountId: str(parsed.accountId) } : {}),
      ...(str(parsed.email) ? { email: str(parsed.email) } : {}),
      scopes,
      ...(str(parsed.idToken) ? { idToken: str(parsed.idToken) } : {}),
    };
  }

  set(credential: ChatGPTOAuthCredential): void {
    this.write(OAUTH_SECRET_KEY, JSON.stringify(credential));
  }

  /** Erase the credential. SecretStorage has no delete API, so we overwrite with empty. */
  clear(): void {
    this.write(OAUTH_SECRET_KEY, "");
  }

  /** This device's registration; creates and saves the host ID on first use. */
  getRegistration(): ChatGPTRegistration {
    const parsed = this.read(REGISTRATION_SECRET_KEY);
    const hostId = str(parsed?.hostId);
    if (parsed && hostId) {
      return {
        hostId,
        ...(str(parsed.clientId) ? { clientId: str(parsed.clientId) } : {}),
        ...(str(parsed.subject) ? { subject: str(parsed.subject) } : {}),
        ...(str(parsed.email) ? { email: str(parsed.email) } : {}),
      };
    }
    const registration = { hostId: `urn:uuid:${uuidV4()}` };
    this.setRegistration(registration);
    return registration;
  }

  setRegistration(registration: ChatGPTRegistration): void {
    this.write(REGISTRATION_SECRET_KEY, JSON.stringify(registration));
  }

  /** True if the access token has expired or expires within a minute. */
  isExpired(credential: Pick<ChatGPTOAuthCredential, "expiresAt">): boolean {
    return credential.expiresAt <= Date.now() + EXPIRY_BUFFER_MS;
  }

  private read(key: string): Record<string, unknown> | null {
    try {
      const raw = this.app.secretStorage.getSecret(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.app.secretStorage.setSecret(key, value);
    } catch {
      // SecretStorage unavailable: the user sees "not connected" on the next read.
    }
  }
}

/** RFC 9562 version 4 UUID from `crypto.getRandomValues` (works in mobile WebViews). */
function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
