/**
 * The private, unofficial Codex voice route (ADR-14). Compiled only into
 * private builds: every use sits behind `if (__CODEX_VOICE__)`, so the
 * public bundle leaves this module out.
 *
 * - Sign-in: a separate sign-in as the Codex app (device code flow),
 *   stored in SecretStorage under its own key, never in `data.json`.
 * - Call: Codex's internal voice route on chatgpt.com, created through
 *   `requestUrl()`; audio and events over WebRTC like the official route.
 *
 * Desktop and mobile alike: everything goes through `requestUrl()` and
 * WebRTC, and the device code sign-in needs no redirect. OpenAI may change
 * or block this route at any time.
 */
import { App, Modal, Notice, Platform, Setting, requestUrl, type SettingDefinition } from "obsidian";
import type ChatPlugin from "../main";
import type { VoiceRouteId } from "../types";
import { decodeJwt } from "../auth/chatgptOAuth";
import { uuidV4 } from "../auth/chatgptOAuthStore";
import { asRecord, isRecord, readJson } from "../json";
import type { VoiceRoute } from "./session";
import { appLifecycle } from "../platform/lifecycle";

// Plain strings, not templates: public builds can then drop them all.
const ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
/** SecretStorage key, separate from the ChatGPT provider's sign-in (ADR-14). */
const SECRET_KEY = "chatting-with-ai-minus-codex-voice";
const CODEX_MODEL = "gpt-live-1-codex";
export const DEFAULT_CODEX_VOICE = "cove";
/** Codex's voices (its source, 2026-10-05); no endpoint lists them. */
export const CODEX_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
const REFRESH_MARGIN_MS = 300_000;
const SIGN_IN_TIMEOUT_MS = 900_000;

export interface CodexVoiceCredential {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  /** `chatgpt_account_id` from the ID token, sent as `ChatGPT-Account-ID`. */
  accountId: string;
  email?: string;
}

export interface CodexDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function json(response: { json: unknown }): Record<string, unknown> {
  return asRecord(readJson(response));
}

/** The Codex sign-in for voice: device code flow, refresh, sign-out. */
export class CodexVoiceAuth {
  private refreshing?: Promise<CodexVoiceCredential>;

  constructor(private readonly app: App) {}

  getCredential(): CodexVoiceCredential | null {
    try {
      const raw = this.app.secretStorage.getSecret(SECRET_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!isRecord(parsed)) return null;
      const accessToken = str(parsed.accessToken), refreshToken = str(parsed.refreshToken), accountId = str(parsed.accountId);
      if (!accessToken || !refreshToken || !accountId || typeof parsed.expiresAt !== "number") return null;
      return { accessToken, refreshToken, accountId, expiresAt: parsed.expiresAt, idToken: str(parsed.idToken), email: str(parsed.email) };
    } catch {
      return null;
    }
  }

  signOut(): void {
    this.write("");
  }

  /** Step 1: get a code for the user to enter at `verificationUrl`. */
  async startDeviceSignIn(): Promise<CodexDeviceCode> {
    let response;
    try {
      response = await requestUrl({
        url: `${ISSUER}/api/accounts/deviceauth/usercode`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
        throw: false,
      });
    } catch (error) {
      throw new Error(`No connection to auth.openai.com (${error instanceof Error ? error.message : String(error)}). Check the internet connection and try again.`);
    }
    const data = json(response);
    const deviceAuthId = str(data.device_auth_id), userCode = str(data.user_code) ?? str(data.usercode);
    if (response.status < 200 || response.status >= 300 || !deviceAuthId || !userCode) {
      throw new Error(`Couldn't start the Codex sign-in (HTTP ${response.status}).`);
    }
    const interval = typeof data.interval === "number" ? data.interval : typeof data.interval === "string" ? Number.parseInt(data.interval, 10) : 5;
    return { deviceAuthId, userCode, verificationUrl: CODEX_DEVICE_URL, intervalMs: (Number.isFinite(interval) && interval >= 0 ? interval : 5) * 1000 };
  }

  /** Step 2: poll until the user has entered the code, then exchange it and store the tokens. */
  async completeDeviceSignIn(code: CodexDeviceCode, cancelled: () => boolean = () => false): Promise<CodexVoiceCredential> {
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error("Sign-in cancelled.");
      // The user signs in in the browser meanwhile: Obsidian is in the
      // background, where a phone may block its network. Ask again once
      // it's back instead of failing.
      if (appLifecycle.isHidden()) {
        await appLifecycle.whenVisible();
        continue;
      }
      let response;
      try {
        response = await requestUrl({
          url: `${ISSUER}/api/accounts/deviceauth/token`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
          throw: false,
        });
      } catch {
        // No connection (e.g. the host couldn't be resolved): try again.
        await sleep(code.intervalMs);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        const data = json(response);
        const authorizationCode = str(data.authorization_code), codeVerifier = str(data.code_verifier);
        if (!authorizationCode || !codeVerifier) throw new Error("The Codex sign-in returned no code.");
        return this.exchange(authorizationCode, codeVerifier);
      }
      // 403/404: the user hasn't entered the code yet.
      if (response.status !== 403 && response.status !== 404) throw new Error(`The Codex sign-in failed (HTTP ${response.status}).`);
      await sleep(code.intervalMs);
    }
    throw new Error("The sign-in code expired. Start again.");
  }

  /** The credential, refreshed when it expires within 5 minutes; null when signed out. */
  async usableCredential(): Promise<CodexVoiceCredential | null> {
    const credential = this.getCredential();
    if (!credential) return null;
    if (credential.expiresAt - Date.now() > REFRESH_MARGIN_MS) return credential;
    this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async exchange(code: string, codeVerifier: string): Promise<CodexVoiceCredential> {
    const response = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: CODEX_CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`The Codex sign-in failed (HTTP ${response.status}).`);
    return this.store(json(response));
  }

  private async refresh(credential: CodexVoiceCredential): Promise<CodexVoiceCredential> {
    const response = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: credential.refreshToken }),
      throw: false,
    });
    // Signed out or in again meanwhile: leave that alone.
    if (this.getCredential()?.refreshToken !== credential.refreshToken) {
      throw new Error("The Codex sign-in changed while the token was refreshed. Try again.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The Codex sign-in has expired (HTTP ${response.status}). Sign in again in the settings.`);
    }
    return this.store(json(response), credential);
  }

  /** Store the token response; a refresh may omit the ID and refresh tokens. */
  private store(data: Record<string, unknown>, previous?: CodexVoiceCredential): CodexVoiceCredential {
    const accessToken = str(data.access_token);
    const refreshToken = str(data.refresh_token) ?? previous?.refreshToken;
    const idToken = str(data.id_token) ?? previous?.idToken;
    if (!accessToken || !refreshToken) throw new Error("The Codex sign-in returned no tokens.");
    const claims = idToken ? decodeJwt(idToken) : undefined;
    const auth = claims?.["https://api.openai.com/auth"];
    const accountId = (isRecord(auth) ? str(auth.chatgpt_account_id) : undefined) ?? previous?.accountId;
    if (!accountId) throw new Error("The Codex sign-in returned no ChatGPT account.");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
    const exp = decodeJwt(accessToken)?.exp;
    const expiresAt = expiresIn !== undefined ? Date.now() + expiresIn * 1000 : typeof exp === "number" ? exp * 1000 : Date.now() + 3600_000;
    const credential: CodexVoiceCredential = {
      accessToken, refreshToken, accountId, expiresAt,
      ...(idToken ? { idToken } : {}),
      ...(str(claims?.email) ?? previous?.email ? { email: str(claims?.email) ?? previous?.email } : {}),
    };
    this.write(JSON.stringify(credential));
    return credential;
  }

  private write(value: string): void {
    try {
      this.app.secretStorage.setSecret(SECRET_KEY, value);
    } catch {
      // SecretStorage unavailable: the user stays signed out.
    }
  }
}

/** A route that creates calls on Codex's internal voice route. */
export function codexVoiceRoute(auth: CodexVoiceAuth, voice: string, clientVersion: () => Promise<string>): VoiceRoute {
  return {
    name: "codex",
    dialect: "v3",
    waitForStarted: false,
    async connect({ sdp, instructions, items }) {
      const credential = await auth.usableCredential();
      if (!credential) throw new Error("Sign in as Codex in the voice settings first.");
      const version = await clientVersion();
      // Not crypto.randomUUID(): mobile WebViews may lack it.
      const sessionId = uuidV4();
      const response = await requestUrl({
        url: CALL_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-ID": credential.accountId,
          "openai-alpha": "quicksilver=v2",
          "x-session-id": sessionId,
          "session-id": sessionId,
          "thread-id": sessionId,
          originator: "codex_cli_rs",
          "User-Agent": `codex_cli_rs/${version} (${osName()}; ${archName()}) obsidian`,
          version,
        },
        body: JSON.stringify({
          sdp,
          session: {
            instructions,
            audio: { output: { voice: voice || DEFAULT_CODEX_VOICE } },
            delegation: { type: "client" },
            model: CODEX_MODEL,
            ...(items.length ? { initial_items: items } : {}),
          },
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Couldn't start Codex voice (HTTP ${response.status}).`);
      }
      const location = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1] ?? "";
      const callId = location.split("?")[0].split("/").filter(Boolean).pop();
      return { sdp: response.text, callId };
    },
  };
}

function osName(): string {
  return Platform.isMacOS ? "Mac OS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "Unknown";
}

/** The CPU isn't exposed without Node modules; Codex sends e.g. `arm64` here. */
function archName(): string {
  return "unknown";
}

/** Shows the device code and waits for the user to enter it. */
export class CodexVoiceSignInModal extends Modal {
  private closed = false;

  constructor(app: App, private readonly auth: CodexVoiceAuth, private readonly onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    this.start();
  }

  /** Get a code and wait for the sign-in; on failure, offer to try again. */
  private start(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Sign in as Codex (unofficial)").setHeading();
    contentEl.createEl("p", {
      text: "Voice through Codex's internal route, with your ChatGPT plan. It isn't an official API: OpenAI may change or block it.",
    });
    const status = contentEl.createEl("p", { text: "Requesting a code…" });
    this.auth.startDeviceSignIn()
      .then((code) => {
        if (this.closed) return;
        status.setText("1. Open the Codex sign-in page and sign in.");
        const open = contentEl.createEl("button", { text: "Open sign-in page", cls: "mod-cta" });
        open.addEventListener("click", () => window.open(code.verificationUrl, "_blank"));
        contentEl.createEl("p", { text: "2. Enter this code there:" });
        contentEl.createEl("p", { text: code.userCode, cls: "chatting-minus-device-code" });
        const waiting = contentEl.createEl("p", { text: "Waiting for the sign-in…" });
        return this.auth.completeDeviceSignIn(code, () => this.closed).then((credential) => {
          if (this.closed) return;
          waiting.setText("");
          this.close();
          new Notice(credential.email ? `Codex voice: signed in as ${credential.email}.` : "Codex voice: signed in.");
          this.onDone();
        });
      })
      .catch((error: unknown) => {
        if (this.closed) return;
        status.setText(error instanceof Error ? error.message : String(error));
        const retry = contentEl.createEl("button", { text: "Try again" });
        retry.addEventListener("click", () => this.start());
      });
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}

/** What the Codex settings rows need from the settings tab. */
interface SettingsTab {
  app: App;
  plugin: ChatPlugin;
  update(): void;
  codexRouteChosen(): boolean;
}

/** Settings row: the voice route, OpenAI API key or the unofficial Codex sign-in. */
export function codexRouteSetting(tab: SettingsTab): SettingDefinition {
  return {
    name: "Voice route",
    render: (setting) => {
      const s = tab.plugin.settings;
      setting
        .setDesc("The Codex route is unofficial: it uses Codex's internal voice service with your ChatGPT plan and may stop working at any time.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("openai", "OpenAI API key")
            .addOption("codex", "Codex sign-in (unofficial)")
            .setValue(s.voiceRoute)
            .onChange(async (value) => {
              s.voiceRoute = value as VoiceRouteId;
              await tab.plugin.saveSettings();
              tab.update();
            })
        );
    },
  };
}

/** Settings row: the Codex account for voice, with sign-in and sign-out. */
export function codexAccountSetting(tab: SettingsTab): SettingDefinition {
  return {
    name: "Codex account",
    visible: () => tab.codexRouteChosen(),
    render: (setting) => {
      const auth = tab.plugin.codexVoice;
      const credential = auth?.getCredential();
      if (auth && credential) {
        setting
          .setDesc(credential.email ? `Signed in as ${credential.email} (unofficial).` : "Signed in (unofficial).")
          .addButton((button) => {
            button.setButtonText("Sign out").onClick(async () => {
              auth.signOut();
              await tab.plugin.saveSettings();
              tab.update();
            });
            button.setDestructive();
          });
        return;
      }
      setting
        .setDesc("A separate sign-in as the Codex app, only for voice.")
        .addButton((button) =>
          button.setButtonText("Sign in as Codex (unofficial)").onClick(() => {
            if (!auth) return;
            new CodexVoiceSignInModal(tab.app, auth, () => {
              void tab.plugin.saveSettings();
              tab.update();
            }).open();
          })
        );
    },
  };
}
