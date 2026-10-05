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
 *      the code, verify the ID token (RS256 signature against OpenAI's
 *      JWKS, then claims) and the plan scope, store tokens.
 *   4. getUsableCredential() refreshes near expiry; signOut() revokes.
 *
 * "Use another account" registers anew (`dynamic_agent_client`, same host
 * ID); the connected account stays until the new one is validated.
 * "Allow ChatGPT plan use" repeats the sign-in with `prompt=consent`.
 *
 * The pending attempt is saved in SecretStorage, so the paste still works
 * after a phone killed Obsidian while the user was in the browser.
 *
 * All HTTP goes through `requestUrl()` (mobile parity).
 */
import { requestUrl } from "obsidian";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64UrlDecode, verifyRs256, type RsaJwk } from "./rs256";
import { asRecord, getNestedString, isRecord, readJson } from "../json";
import type {
  ChatGPTOAuthCredential,
  ChatGPTOAuthStore,
  PendingSignIn,
} from "./chatgptOAuthStore";

export type { PendingSignIn } from "./chatgptOAuthStore";

export const ISSUER = "https://auth.openai.com";
/** OIDC discovery document; its `jwks_uri` holds the ID token signing keys. */
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
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
  /** `planNotAllowed`: plan use was declined; a sign-in with `consent` can ask again. */
  constructor(message: string, readonly planNotAllowed = false) {
    super(message);
    this.name = "ChatGPTOAuthError";
  }
}

/**
 * The usage limit of the ChatGPT plan (or of this app) is reached. Not
 * retried: OpenAI asks apps to pause and link to the usage settings.
 */
export class ChatGPTUsageLimitError extends ChatGPTOAuthError {
  constructor(message: string) {
    super(message);
    this.name = "ChatGPTUsageLimitError";
  }
}

export interface SignInOptions {
  /** Register a new client for another ChatGPT account. */
  newAccount?: boolean;
  /** Ask again for plan use (`prompt=consent`), after it was declined. */
  consent?: boolean;
}

/**
 * How long a sign-in attempt lives. Within it, reopening the dialog (or
 * restarting Obsidian) keeps the same attempt, so an address copied after
 * the dialog was closed still matches.
 */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** Wait before the one retry of a failed revocation. */
const REVOKE_RETRY_MS = 1000;

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

export { verifyRs256 } from "./rs256";

/** Decode one JWT part (0 header, 1 payload) as a JSON object, without checking the signature. */
export function decodeJwt(token: string, index = 1): Record<string, unknown> | undefined {
  const bytes = base64UrlDecode(token.split(".")[index] ?? "");
  if (!bytes?.length) return undefined;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(json) ? json : undefined;
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
    throw new ChatGPTOAuthError("Sign-in was cancelled, or use of your ChatGPT plan was declined.", true);
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

/** Check issuer, audience, expiry and nonce. The signature is checked before (see verifySignature). */
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
  const error = asRecord(json).error;
  return typeof error === "string" ? error : getNestedString(error, ["code"]);
}

function describe(response: { status: number; text?: string }): string {
  const text = typeof response.text === "string" ? response.text.trim().slice(0, 300) : "";
  return text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`;
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

/**
 * Revoke a refresh token. A network error or 5xx is retried once; an empty
 * 200 is success (also for an already-invalid token).
 */
async function revoke(refreshToken: string, clientId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => window.setTimeout(resolve, REVOKE_RETRY_MS));
    try {
      const response = await postForm(REVOKE_URL, { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId });
      if (response.status < 500) return response.status === 200;
    } catch {
      // Network error: retry.
    }
  }
  return false;
}

export class ChatGPTOAuthService {
  /** The sign-in attempt whose callback we're waiting for; undefined until read from SecretStorage. */
  private pending: PendingSignIn | null | undefined;
  /** OpenAI's ID token signing keys, cached for this session. */
  private signingKeys: RsaJwk[] | null = null;
  /** Serializes refreshes: refresh tokens rotate, so two refreshes would race. */
  private refreshing: Promise<ChatGPTOAuthCredential> | null = null;

  constructor(private readonly store: ChatGPTOAuthStore) {}

  /** Synchronous read of the stored credential (whether or not it's expired). */
  getCredential(): ChatGPTOAuthCredential | null {
    return this.store.get();
  }

  /**
   * The current authorization attempt, or a new one (fresh PKCE, state,
   * nonce and port) if there is none, it is over 10 minutes old, or it was
   * started with other options.
   */
  beginSignIn(options: SignInOptions = {}): PendingSignIn {
    const registration = this.store.getRegistration();
    const clientId = options.newAccount ? NEW_REGISTRATION_CLIENT_ID : registration.clientId ?? NEW_REGISTRATION_CLIENT_ID;
    const consent = options.consent === true;
    const current = this.currentAttempt();
    if (current && current.clientId === clientId && (current.consent === true) === consent) return current;
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
    // OAuth `prompt`; OpenAI's `force_reconsent` replaces it once rolled out.
    if (consent) params.set("prompt", "consent");
    this.pending = {
      url: `${AUTHORIZE_URL}?${params.toString()}`,
      state, nonce, codeVerifier, redirectUri, clientId,
      createdAt: Date.now(),
      ...(consent ? { consent } : {}),
    };
    this.store.setPending(this.pending);
    return this.pending;
  }

  /** The pending attempt (read lazily from SecretStorage), or null if none or expired. */
  private currentAttempt(): PendingSignIn | null {
    if (this.pending === undefined) this.pending = this.store.getPending();
    const age = this.pending ? Date.now() - this.pending.createdAt : 0;
    if (this.pending && (age < 0 || age >= SIGN_IN_TTL_MS)) this.endAttempt();
    return this.pending;
  }

  private endAttempt(): void {
    this.pending = null;
    this.store.clearPending();
  }

  /** Finish the pending attempt with the pasted callback address. */
  async completeSignIn(callbackUrl: string): Promise<ChatGPTOAuthCredential> {
    const pending = this.currentAttempt();
    if (!pending) throw new ChatGPTOAuthError("No sign-in is waiting (attempts expire after 10 minutes). Open the sign-in page again.");
    const { code, clientId } = parseCallback(callbackUrl, pending);
    // Load the signing keys before the single-use code is spent: without
    // them the ID token can't be verified, and the attempt stays open.
    await this.loadSigningKeys(false);
    const registration = this.store.getRegistration();
    const newRegistration = pending.clientId === NEW_REGISTRATION_CLIENT_ID;
    // Switching accounts: the connected one stays until the new one is validated.
    const previous = newRegistration ? this.store.get() : null;
    // Otherwise keep the issued client ID at once, even if the exchange
    // fails: retries reuse it. The new client belongs to an account not yet known.
    if (newRegistration && !previous) this.store.setRegistration({ hostId: registration.hostId, clientId });

    const response = await postForm(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
      resource: RESOURCE,
    });
    // A code is single-use: any result ends this attempt.
    this.endAttempt();
    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(errorCode(readJson(response)) === "invalid_grant"
        ? "The sign-in code was rejected or has expired. Open the sign-in page again."
        : `Token exchange failed (${describe(response)}).`);
    }
    const tokens = readJson(response) as TokenResponse | undefined;
    await this.verifySignature(tokens?.id_token);
    const claims = validateIdToken(tokens?.id_token, clientId, pending.nonce);
    // An issued client is bound to its account.
    if (!newRegistration && registration.subject && registration.subject !== claims.sub) {
      throw new ChatGPTOAuthError("This is a different ChatGPT account than the one registered on this device. To connect it, choose \"Use another account\".");
    }
    const credential = this.toCredential(tokens, claims.sub, claims.email);
    const identity = { hostId: registration.hostId, clientId, subject: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
    if (!credential.scopes.includes(PLAN_SCOPE)) {
      if (!previous) this.store.setRegistration(identity);
      throw new ChatGPTOAuthError("Use of your ChatGPT plan wasn't allowed.", true);
    }
    // Replace the previous account: end its session (best effort).
    if (previous && registration.clientId) await revoke(previous.refreshToken, registration.clientId);
    this.store.setRegistration(identity);
    this.store.set(credential);
    return credential;
  }

  /**
   * OpenAI's signing keys: from the cache, or through the discovery
   * document's `jwks_uri`. Fails closed when they can't be loaded.
   */
  private async loadSigningKeys(refetch: boolean): Promise<RsaJwk[]> {
    if (this.signingKeys && !refetch) return this.signingKeys;
    const unavailable = "Couldn't load OpenAI's keys to check the sign-in. Check your connection and paste the address again.";
    try {
      const discovery = readJson(await requestUrl({ url: DISCOVERY_URL, throw: false })) as { jwks_uri?: unknown } | undefined;
      const jwksUri = discovery?.jwks_uri;
      if (typeof jwksUri !== "string" || !jwksUri.startsWith(`${ISSUER}/`)) throw new ChatGPTOAuthError(unavailable);
      const jwks = readJson(await requestUrl({ url: jwksUri, throw: false })) as { keys?: unknown } | undefined;
      if (!Array.isArray(jwks?.keys)) throw new ChatGPTOAuthError(unavailable);
      this.signingKeys = jwks.keys.filter((key): key is RsaJwk => isRecord(key));
      return this.signingKeys;
    } catch (error) {
      throw error instanceof ChatGPTOAuthError ? error : new ChatGPTOAuthError(unavailable);
    }
  }

  /** Verify the ID token's RS256 signature; an unknown key ID refetches the keys once. */
  private async verifySignature(idToken: string | undefined): Promise<void> {
    const parts = idToken?.split(".") ?? [];
    const header = idToken ? decodeJwt(idToken, 0) : undefined;
    const signature = base64UrlDecode(parts[2] ?? "");
    if (parts.length !== 3 || header?.alg !== "RS256" || !signature) {
      throw new ChatGPTOAuthError("Sign-in returned no valid ID token.");
    }
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const matching = (keys: RsaJwk[]) => keys.filter(key => !kid || key.kid === kid);
    let keys = matching(await this.loadSigningKeys(false));
    if (!keys.length) keys = matching(await this.loadSigningKeys(true));
    if (!keys.length) throw new ChatGPTOAuthError("The ID token is signed with a key OpenAI doesn't publish.");
    if (!keys.some(key => verifyRs256(`${parts[0]}.${parts[1]}`, signature, key))) {
      throw new ChatGPTOAuthError("The ID token's signature is invalid.");
    }
  }

  /**
   * Revoke the refresh token, then clear the tokens. Keeps the registration
   * (host and client ID) for the next sign-in. Returns whether OpenAI
   * confirmed the revocation.
   */
  async signOut(): Promise<boolean> {
    const credential = this.store.get();
    const clientId = this.store.getRegistration().clientId;
    const revoked = credential && clientId ? await revoke(credential.refreshToken, clientId) : false;
    this.store.clear();
    return revoked;
  }

  /** Refresh the access token; replaces all tokens together. */
  refreshCredential(credential: ChatGPTOAuthCredential): Promise<ChatGPTOAuthCredential> {
    this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * A new credential after the API rejected `rejected` (401): the stored
   * one if another request refreshed it meanwhile, else a forced refresh
   * (merged with one already running). Null when signed out. Throws if the
   * refresh fails; only an unusable refresh token clears the sign-in.
   */
  async renewRejected(rejected: ChatGPTOAuthCredential): Promise<ChatGPTOAuthCredential | null> {
    const current = this.store.get();
    if (!current) return null;
    if (current.accessToken !== rejected.accessToken) return current;
    return this.refreshCredential(current);
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

  /**
   * Refreshes `credential`. Disconnect or another sign-in may replace the
   * stored credential while the request runs: the result then stores or
   * clears nothing, and the caller gets an error.
   */
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
    if (this.store.get()?.refreshToken !== credential.refreshToken) {
      throw new ChatGPTOAuthError("The ChatGPT sign-in changed while the token was refreshed. Try again.");
    }
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
