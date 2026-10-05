/**
 * ChatGPT sign-in through OpenAI's "Sign in with ChatGPT" for open-source
 * apps (ADR-13). Docs: developers.openai.com/siwc/token-sharing-open-source
 *
 * Flow:
 *   1. beginSignIn(): authorize URL with PKCE (S256), state and nonce. The
 *      redirect goes to a loopback URL on 127.0.0.1 where nothing listens
 *      (mobile can't run a server).
 *   2. The user signs in, the browser lands on that URL and fails to load
 *      it; the user pastes the address into the plugin.
 *   3. completeSignIn(): check state, keep the issued client ID, exchange
 *      the code, validate the ID token and the plan scope, store tokens.
 *   4. getUsableCredential() refreshes near expiry; signOut() revokes.
 *
 * All HTTP goes through `requestUrl()` (mobile parity).
 */
import { requestUrl } from "obsidian";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  ChatGPTOAuthCredential,
  ChatGPTOAuthStore,
} from "./chatgptOAuthStore";

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
/** `revocation_endpoint` from `${ISSUER}/.well-known/openid-configuration`. */
export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** First-registration entry point; never saved or used for token exchange. */
export const NEW_REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Chatting with AI Minus";
export const USAGE_URL = "https://chatgpt.com/settings/usage";
const CALLBACK_PATH = "/auth/callback";
/** Dynamic port range; only the port of the redirect URI may vary. */
const PORT_MIN = 49152;
const PORT_MAX = 65535;
const CLOCK_SKEW_MS = 5 * 60_000;
/** Refresh error codes after which the refresh token can't be used again. */
const TERMINAL_REFRESH_ERRORS = ["invalid_grant", "invalid_refresh_token", "token_expired",
  "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];

export class ChatGPTOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGPTOAuthError";
  }
}

/** One authorization attempt; kept in memory until the callback is pasted. */
export interface PendingSignIn {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** `dynamic_agent_client` for a new registration, else the issued client ID. */
  clientId: string;
  /** Epoch ms; the attempt is reused until it is used or SIGN_IN_REUSE_MS old. */
  createdAt: number;
}

/**
 * How long reopening the sign-in dialog keeps the same attempt, so an
 * address copied after the dialog was closed still matches.
 */
const SIGN_IN_REUSE_MS = 10 * 60 * 1000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: string;
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomToken = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE S256: base64url(SHA-256(verifier)) without padding. */
export function codeChallenge(verifier: string): string {
  return base64Url(sha256(new TextEncoder().encode(verifier)));
}

/** Decode a JWT payload without checking its signature (see validateIdToken). */
export function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const json: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    return typeof json === "object" && json !== null ? json as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the pasted callback address. Only the full address is accepted: a
 * bare code can't be checked against `state` and lacks the issued client ID.
 */
export function parseCallback(input: string, pending: PendingSignIn): { code: string; clientId: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ChatGPTOAuthError("Paste the whole address, starting with http://127.0.0.1.");
  }
  if (`${url.origin}${url.pathname}` !== pending.redirectUri) {
    throw new ChatGPTOAuthError("That isn't the address of this sign-in. Paste the address of the page you land on after signing in.");
  }
  const params = url.searchParams;
  if (params.get("state") !== pending.state) {
    throw new ChatGPTOAuthError("This address belongs to another sign-in attempt. Open the sign-in page again.");
  }
  const error = params.get("error");
  if (error === "access_denied") {
    throw new ChatGPTOAuthError("Sign-in was cancelled, or use of your ChatGPT plan was declined.");
  }
  if (error) {
    throw new ChatGPTOAuthError(`Sign-in failed: ${params.get("error_description") || error}`);
  }
  const code = params.get("code");
  if (!code) {
    throw new ChatGPTOAuthError("The address has no sign-in code. Copy the full address after signing in.");
  }
  const returned = params.get("client_id");
  if (pending.clientId === NEW_REGISTRATION_CLIENT_ID) {
    if (!returned || returned === NEW_REGISTRATION_CLIENT_ID) {
      throw new ChatGPTOAuthError("Registration is incomplete: the address has no client ID. Open the sign-in page again.");
    }
    return { code, clientId: returned };
  }
  if (returned && returned !== pending.clientId) {
    throw new ChatGPTOAuthError("The address belongs to another app registration. Open the sign-in page again.");
  }
  return { code, clientId: pending.clientId };
}

/**
 * Check issuer, audience, expiry and nonce. The signature isn't checked:
 * the token comes straight from the token endpoint over TLS, which OIDC
 * Core 3.1.3.7 accepts in place of the signature check.
 */
export function validateIdToken(idToken: string | undefined, clientId: string, nonce: string): IdTokenClaims & { sub: string } {
  const claims = idToken ? decodeJwt(idToken) as IdTokenClaims | undefined : undefined;
  if (!claims) throw new ChatGPTOAuthError("Sign-in returned no valid ID token.");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new ChatGPTOAuthError("The ID token has the wrong issuer.");
  if (!audience.includes(clientId)) throw new ChatGPTOAuthError("The ID token was issued for another client.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - CLOCK_SKEW_MS) {
    throw new ChatGPTOAuthError("The ID token has expired.");
  }
  if (claims.nonce !== nonce) throw new ChatGPTOAuthError("The ID token doesn't match this sign-in attempt.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new ChatGPTOAuthError("The ID token has no account.");
  return { ...claims, sub: claims.sub };
}

/** Error text from an OAuth or API error body (`error`, `error.code`, `detail`). */
function errorCode(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const error = (json as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describe(response: { status: number; text?: string }): string {
  const text = typeof response.text === "string" ? response.text.trim().slice(0, 300) : "";
  return text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`;
}

function readJson(response: { json?: unknown }): unknown {
  try {
    return response.json;
  } catch {
    return undefined;
  }
}

async function postForm(url: string, form: Record<string, string>) {
  return requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    throw: false,
  });
}

export class ChatGPTOAuthService {
  /** The sign-in attempt whose callback we're waiting for. */
  private pending: PendingSignIn | null = null;
  /** Serializes refreshes: refresh tokens rotate, so two refreshes would race. */
  private refreshing: Promise<ChatGPTOAuthCredential> | null = null;

  constructor(private readonly store: ChatGPTOAuthStore) {}

  /** Synchronous read of the stored credential (whether or not it's expired). */
  getCredential(): ChatGPTOAuthCredential | null {
    return this.store.get();
  }

  /**
   * The current authorization attempt, or a new one (fresh PKCE, state,
   * nonce and port) if there is none or it is over 10 minutes old.
   */
  beginSignIn(): PendingSignIn {
    if (this.pending && Date.now() - this.pending.createdAt < SIGN_IN_REUSE_MS) return this.pending;
    const registration = this.store.getRegistration();
    const clientId = registration.clientId ?? NEW_REGISTRATION_CLIENT_ID;
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: codeChallenge(codeVerifier),
      ext_agent_host_id: registration.hostId,
    });
    // The name hint belongs only to the first registration.
    if (clientId === NEW_REGISTRATION_CLIENT_ID) params.set("agent_name_hint", AGENT_NAME);
    else if (registration.email) params.set("login_hint", registration.email);
    this.pending = {
      url: `${AUTHORIZE_URL}?${params.toString()}`,
      state, nonce, codeVerifier, redirectUri, clientId,
      createdAt: Date.now(),
    };
    return this.pending;
  }

  /** Finish the pending attempt with the pasted callback address. */
  async completeSignIn(callbackUrl: string): Promise<ChatGPTOAuthCredential> {
    const pending = this.pending;
    if (!pending) throw new ChatGPTOAuthError("Open the sign-in page first.");
    const { code, clientId } = parseCallback(callbackUrl, pending);
    const registration = this.store.getRegistration();
    // Keep the issued client ID even if the exchange fails: retries reuse it.
    if (registration.clientId !== clientId) this.store.setRegistration({ ...registration, clientId });

    const response = await postForm(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
      resource: RESOURCE,
    });
    // A code is single-use: any result ends this attempt.
    this.pending = null;
    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(errorCode(readJson(response)) === "invalid_grant"
        ? "The sign-in code was rejected or has expired. Open the sign-in page again."
        : `Token exchange failed (${describe(response)}).`);
    }
    const tokens = readJson(response) as TokenResponse | undefined;
    const claims = validateIdToken(tokens?.id_token, clientId, pending.nonce);
    if (registration.subject && registration.subject !== claims.sub) {
      throw new ChatGPTOAuthError("This is a different ChatGPT account than the one registered on this device.");
    }
    const credential = this.toCredential(tokens, claims.sub, claims.email);
    if (!credential.scopes.includes(PLAN_SCOPE)) {
      throw new ChatGPTOAuthError("Use of your ChatGPT plan wasn't allowed. Continue with ChatGPT again and allow it.");
    }
    this.store.setRegistration({ ...this.store.getRegistration(), clientId, subject: claims.sub,
      ...(claims.email ? { email: claims.email } : {}) });
    this.store.set(credential);
    return credential;
  }

  /**
   * Revoke the refresh token, then clear the tokens. Keeps the registration
   * (host and client ID) for the next sign-in. Returns whether OpenAI
   * confirmed the revocation.
   */
  async signOut(): Promise<boolean> {
    const credential = this.store.get();
    const clientId = this.store.getRegistration().clientId;
    let revoked = false;
    if (credential && clientId) {
      try {
        const response = await postForm(REVOKE_URL, {
          token: credential.refreshToken,
          token_type_hint: "refresh_token",
          client_id: clientId,
        });
        revoked = response.status === 200;
      } catch {
        revoked = false;
      }
    }
    this.store.clear();
    return revoked;
  }

  /** Refresh the access token; replaces all tokens together. */
  refreshCredential(credential: ChatGPTOAuthCredential): Promise<ChatGPTOAuthCredential> {
    this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * A currently valid credential, refreshed if needed. Null when not
   * connected. Throws if a needed refresh fails.
   */
  async getUsableCredential(): Promise<ChatGPTOAuthCredential | null> {
    const current = this.store.get();
    if (!current) return null;
    if (!this.store.isExpired(current)) return current;
    return this.refreshCredential(current);
  }

  private async refresh(credential: ChatGPTOAuthCredential): Promise<ChatGPTOAuthCredential> {
    const clientId = this.store.getRegistration().clientId;
    if (!clientId) {
      this.store.clear();
      throw new ChatGPTOAuthError("ChatGPT sign-in is incomplete. Continue with ChatGPT in settings.");
    }
    const response = await postForm(TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: credential.refreshToken,
      resource: RESOURCE,
    });
    if (response.status < 200 || response.status >= 300) {
      const code = errorCode(readJson(response));
      if (code && TERMINAL_REFRESH_ERRORS.includes(code)) {
        this.store.clear();
        throw new ChatGPTOAuthError("Your ChatGPT sign-in has expired. Continue with ChatGPT in settings.");
      }
      throw new ChatGPTOAuthError(`ChatGPT token refresh failed (${describe(response)}).`);
    }
    const next = this.toCredential(readJson(response) as TokenResponse | undefined, credential.accountId, credential.email, credential);
    this.store.set(next);
    return next;
  }

  private toCredential(
    tokens: TokenResponse | undefined,
    accountId: string | undefined,
    email: string | undefined,
    previous?: ChatGPTOAuthCredential,
  ): ChatGPTOAuthCredential {
    if (!tokens?.access_token || !(tokens.refresh_token || previous?.refreshToken)) {
      throw new ChatGPTOAuthError("The token response is missing tokens.");
    }
    // Granted scopes: from the response, else from the access token's claims.
    const scopeText = tokens.scope ?? decodeJwt(tokens.access_token)?.scope;
    const scopes = typeof scopeText === "string" ? scopeText.split(" ").filter(Boolean) : previous?.scopes;
    const now = Date.now();
    const idToken = tokens.id_token ?? previous?.idToken;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous!.refreshToken,
      expiresAt: now + (typeof tokens.expires_in === "number" ? tokens.expires_in : 3600) * 1000,
      updatedAt: now,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
      scopes: scopes ?? [],
      ...(idToken ? { idToken } : {}),
    };
  }
}
