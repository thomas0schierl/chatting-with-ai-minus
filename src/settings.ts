import { App, Modal, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type ChatPlugin from "./main";
import type { ChatSettings, Provider, VoiceMicMode } from "./types";
import { DEFAULT_PROVIDER_MODELS } from "./types";
import { clearDebugLog } from "./debug";
import {
  ChatGPTOAuthError,
  NEW_REGISTRATION_CLIENT_ID,
  USAGE_URL,
  type ChatGPTOAuthService,
  type PendingSignIn,
  type SignInOptions,
} from "./auth/chatgptOAuth";

import { LIVE_VOICES, hasLiveAccess } from "./voice/openai-live";
import { CODEX_VOICES, codexAccountSetting, codexRouteSetting } from "./voice/codex";

import { type ModelOption, secretIdentity, catalogIdentity, cachedCatalog, refreshCatalog, getCatalogModels, clearCatalogModels, catalogModel, resolveThinkingLevel, thinkingLevelLabel, CATALOG_TTL } from "./api/model-catalog";

const CUSTOM_MODEL_OPTION = "__custom__";

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  // Shown until the account's own list has loaded.
  "chatgpt-oauth": [
    { value: "gpt-5.5", label: "GPT-5.5 (recommended)" },
  ],
};



/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const cached = getCatalogModels(provider as Provider);
  const models = cached || FALLBACK_MODELS[provider] || [];
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

/** Chat header: model name, plus the effective thinking level when the model offers levels. */
export function getModelHeaderLabel(provider: Provider, modelId: string, level: string): string {
  const thinking = thinkingLevelLabel(catalogModel(provider, modelId), level);
  const name = getModelDisplayName(provider, modelId);
  return thinking ? `${name} · ${thinking}` : name;
}

/**
 * The Test buttons: one word back, as fast as the model allows. The lightest
 * thinking level the catalog lists (providers list them lightest first) and
 * no web search; the chat settings stay as they are.
 */
export async function connectionTest(settings: ChatSettings): Promise<string> {
  const { sendMessage } = await import("./api/client");
  const efforts = catalogModel(settings.provider, settings.model)?.reasoningEfforts;
  const response = await sendMessage(
    { ...settings, enableWebSearch: false, thinkingLevel: efforts?.[0] ?? settings.thinkingLevel },
    [{ role: "user", content: "Say hello in one word." }],
    [],
    "You are a test. Respond with one word.",
  );
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;
  private catalogModels?: ModelOption[];
  private catalogIdentity = "";
  private loadingCatalog = false;
  private catalogError = "";
  private apiKeyEditing = false;
  private apiKeyTimer?: number;
  /** "Custom..." is picked in the model dropdown: show the model ID field. */
  private editingCustomModel = false;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Scopes the wrapping rows in styles.css (several buttons on a phone).
    this.containerEl.addClass("chatting-minus-settings");
  }

  // Obsidian renders the tab from these definitions and indexes them for search.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: "Provider", render: setting => this.renderProvider(setting) },
      { name: "API key", visible: () => this.plugin.settings.provider !== "chatgpt-oauth", render: setting => this.renderApiKeySection(setting) },
      { name: "ChatGPT account", visible: () => this.plugin.settings.provider === "chatgpt-oauth", render: setting => this.renderChatGPTOAuthSection(setting) },
      { name: "Model", aliases: ["Custom model ID", "Refresh models"], render: setting => {
        this.renderModelSection(setting.settingEl.parentElement!, setting);
        void this.loadCatalog(false);
      } },
      { name: "Thinking level", visible: () => !!this.thinkingOptions(), render: setting => this.renderThinkingLevel(setting) },
      { name: "Web search", render: setting => this.renderWebSearch(setting) },
      { name: "Enter sends message", aliases: ["Keyboard", "New line"], render: setting => this.renderEnterSends(setting) },
      { name: "Max tool iterations", render: setting => this.renderMaxIterations(setting) },
      { type: "group", heading: "Voice", items: [
        // The unofficial Codex route, off unless chosen and confirmed (ADR-14).
        codexRouteSetting(this),
        { name: "OpenAI API key for voice", aliases: ["GPT-Live"], visible: () => !this.codexRouteChosen(), render: setting => this.renderVoiceKey(setting) },
        codexAccountSetting(this),
        { name: "Voice", render: setting => this.renderVoiceName(setting) },
        { name: "Microphone", aliases: ["Hold to talk", "Hands-free"], render: setting => this.renderMicMode(setting) },
      ] },
      { name: "Debug log", aliases: ["Troubleshooting"], render: setting => this.renderDebugLog(setting) },
    ];
  }

  hide(): void {
    super.hide();
    this.editingCustomModel = false;
    window.clearTimeout(this.apiKeyTimer);
    this.apiKeyEditing = false;
  }

  /** After a ChatGPT sign-in: the one-time plan welcome, later a short notice. */
  private async afterSignIn(): Promise<void> {
    this.update();
    if (this.plugin.settings.chatgptPlanWelcomeShown) {
      new Notice("ChatGPT connected. Chats now use your ChatGPT plan.");
      return;
    }
    this.plugin.settings.chatgptPlanWelcomeShown = true;
    await this.plugin.saveSettings();
    new ChatGPTPlanWelcomeModal(this.app).open();
  }

  private renderProvider(setting: Setting): void {
    const s = this.plugin.settings;
    // ─── Provider ─────────────────────────────────────────────────────
    setting
      .setName("Provider")
      .setDesc("Which AI provider to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI")
          .addOption("chatgpt-oauth", "ChatGPT OAuth")
          .setValue(s.provider)
          .onChange(async (value) => {
            // Load the new provider's key BEFORE saving,
            // otherwise the old provider's key gets saved under the new provider name
            clearCatalogModels(s.provider);
            this.catalogModels = undefined;
            this.catalogIdentity = "";
            s.provider = value as Provider;
            s.model = DEFAULT_PROVIDER_MODELS[s.provider];
            // Levels are named per provider, so start from the model's default.
            s.thinkingLevel = "";
            this.editingCustomModel = false;
            this.plugin.reloadApiKeyForProvider();
            await this.plugin.saveSettings();
            window.setTimeout(() => this.update(), 10);
          })
      );

  }
  private renderEnterSends(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Enter sends message")
      .setDesc("On: Enter sends, Shift+Enter starts a new line. Off: Enter starts a new line; send with the send button or Ctrl+Enter (Cmd+Enter on a Mac).")
      .addToggle((toggle) =>
        toggle.setValue(s.enterSends).onChange(async (value) => {
          s.enterSends = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderWebSearch(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Web search")
      .setDesc("Allow the model to search the web when it needs current information")
      .addToggle((toggle) =>
        toggle
          .setValue(s.enableWebSearch)
          .onChange(async (value) => {
            s.enableWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

  }
  private renderDebugLog(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Debug log")
      .setDesc("For troubleshooting: writes requests, errors, background and voice events to debug.log in the plugin folder, including your messages (never keys). Copy it to send it on.")
      .addToggle((toggle) =>
        toggle.setValue(s.debugLog).onChange(async (value) => {
          s.debugLog = value;
          await this.plugin.saveSettings();
        })
      )
      .addButton((button) => button.setButtonText("Copy").onClick(() => void this.plugin.copyDebugLog()))
      .addButton((button) => button.setButtonText("Clear").onClick(async () => {
        await clearDebugLog(this.app);
        new Notice("Debug log cleared.");
      }));
  }

  private renderMaxIterations(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Max tool iterations")
      .setDesc("Safety limit for the agent loop (default: 20)")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }

  // ─── Voice (ADR-11; Codex route ADR-14) ───────────────────────────────────

  /** The unofficial Codex route is chosen (ADR-14). */
  codexRouteChosen(): boolean {
    return this.plugin.settings.voiceRoute === "codex";
  }

  private renderVoiceKey(setting: Setting): void {
    const s = this.plugin.settings;
    const cost = "Voice uses OpenAI GPT-Live, billed at $0.05 per minute of conversation, silence included.";
    setting.setName("OpenAI API key for voice");
    if (s.provider === "openai") {
      setting.setDesc(`${cost} It uses the OpenAI API key above.`);
    } else {
      const key = this.plugin.loadApiKey("openai");
      setting
        .setDesc(`${cost} The key is shared with the OpenAI provider.`)
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Enter your OpenAI API key")
            .setValue(key)
            .onChange(async (value) => {
              await this.plugin.saveOpenAIKey(value.trim());
            });
        });
    }
    setting.addButton((button) =>
      button.setButtonText("Check access").onClick(async () => {
        const key = this.plugin.loadApiKey("openai");
        if (!key) {
          new Notice("Enter an OpenAI API key first.");
          return;
        }
        button.setDisabled(true);
        try {
          new Notice(await hasLiveAccess(key)
            ? "This key can use voice (gpt-live-1)."
            : "This key's account doesn't list gpt-live-1 yet.");
        } catch (e) {
          new Notice(e instanceof Error ? e.message : String(e));
        } finally {
          button.setDisabled(false);
        }
      })
    );
  }

  private renderVoiceName(setting: Setting): void {
    const s = this.plugin.settings;
    const voices = this.codexRouteChosen() ? CODEX_VOICES : LIVE_VOICES;
    const current = this.codexRouteChosen() ? s.codexVoice : s.voice;
    setting
      .setName("Voice")
      .setDesc("How the assistant sounds.")
      .addDropdown((dropdown) => {
        for (const voice of voices) dropdown.addOption(voice, voice.charAt(0).toUpperCase() + voice.slice(1));
        if (!voices.includes(current)) dropdown.addOption(current, current);
        dropdown.setValue(current).onChange(async (value) => {
          if (this.codexRouteChosen()) s.codexVoice = value;
          else s.voice = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderMicMode(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Microphone")
      .setDesc("Hands-free: just talk; the voice answers when you pause. Hold to talk: the microphone is on only while you hold the button.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hands-free", "Hands-free")
          .addOption("hold", "Hold to talk")
          .setValue(s.voiceMicMode)
          .onChange(async (value) => {
            s.voiceMicMode = value as VoiceMicMode;
            await this.plugin.saveSettings();
          })
      );
  }

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(row: Setting): void {
    const s = this.plugin.settings;

    const apiKeySetting = row
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            this.apiKeyEditing = true;
            window.clearTimeout(this.apiKeyTimer);
            const hadKey = s.apiKey;
            s.apiKey = value.trim();
            const editedKey = s.apiKey;
            await this.plugin.saveSettings();
            if (s.apiKey !== editedKey) return;
            if (hadKey !== s.apiKey) {
              clearCatalogModels(s.provider);
              this.catalogModels = undefined;
              this.catalogIdentity = "";
            }
            this.apiKeyTimer = window.setTimeout(() => {
              this.apiKeyEditing = false;
              this.update();
            }, 800);
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const text = await connectionTest(s);
            new Notice(`Connected! Response: "${text}"`);
            apiKeySetting.setDesc("Connection successful");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
            apiKeySetting.setDesc(`Failed: ${msg}`);
          } finally {
            button.setButtonText("Test");
            button.setDisabled(false);
          }
        })
      );
    }
  }

  // ─── ChatGPT OAuth ────────────────────────────────────────────────────────

  private renderChatGPTOAuthSection(row: Setting): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    if (credential) {
      row
        .setName("ChatGPT account")
        .setDesc(credential.email ? `Using your ChatGPT plan as ${credential.email}.` : "Using your ChatGPT plan.")
        .addButton((button) => button.setButtonText("Manage usage").onClick(() => {
          window.open(USAGE_URL, "_blank");
        }))
        .addButton((button) => button.setButtonText("Use another account").onClick(() => {
          new ChatGPTSignInModal(this.app, this.plugin.chatgptOAuth, () => void this.afterSignIn(), { newAccount: true }).open();
        }))
        .addButton((button) => {
          button
            .setButtonText("Disconnect")
            .onClick(async () => {
              const revoked = await this.plugin.chatgptOAuth.signOut();
              clearCatalogModels("chatgpt-oauth");
              this.catalogModels = undefined;
              this.catalogIdentity = "";
              const catalog = this.plugin.settings.modelCatalog;
              catalog.entries = catalog.entries.filter(e => e.provider !== "chatgpt-oauth");
              await this.plugin.saveSettings();
              new Notice(revoked
                ? "ChatGPT disconnected."
                : "Disconnected on this device. OpenAI didn't confirm the sign-out; you can remove the app in ChatGPT settings.");
              this.update();
            });
          button.setDestructive();
        })
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              const text = await connectionTest(this.plugin.settings);
              new Notice(`Connected! Response: "${text || "(no text)"}"`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Connection test failed: ${msg}`);
            } finally {
              button.setButtonText("Test");
              button.setDisabled(false);
            }
          })
        );
    } else {
      row
        .setName("ChatGPT account")
        .setDesc("Use your ChatGPT plan instead of an API key.")
        .addButton((button) =>
          button
            .setButtonText("Continue with ChatGPT")
            .setCta()
            .onClick(() => {
              new ChatGPTSignInModal(this.app, this.plugin.chatgptOAuth, () => void this.afterSignIn()).open();
            })
        );
    }
  }

  // ─── Model picker ─────────────────────────────────────────────────────────

  private renderModelSection(containerEl: HTMLElement, row: Setting): void {
    const s = this.plugin.settings;
    const cached = this.catalogModels;
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = row
      .setName("Model")
      .setDesc(this.catalogError || (cached ? `${cached.length} models. Cached for 24 hours; refresh to check now.` : "Using defaults. Models load automatically when connected."))
      .addDropdown((dropdown) => {
        for (const m of models) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown.addOption(CUSTOM_MODEL_OPTION, "Custom...");

        // If current model isn't in the list, add it
        if (s.model && !models.some((m) => m.value === s.model)) {
          dropdown.addOption(s.model, `${s.model} (current)`);
        }

        dropdown.setValue(this.editingCustomModel ? CUSTOM_MODEL_OPTION : s.model);
        dropdown.onChange(async (value) => {
          if (value === CUSTOM_MODEL_OPTION) {
            // UI state only: the model changes once an ID is typed.
            this.editingCustomModel = true;
            this.update();
            return;
          }
          this.editingCustomModel = false;
          s.model = value;
          await this.plugin.saveSettings();
          // The thinking levels on offer depend on the model.
          this.update();
        });
      });

    if (this.credentialIdentity()) {
      modelSetting.addButton(btn => btn.setIcon("refresh-cw").setTooltip("Refresh models now")
        .setDisabled(this.loadingCatalog).onClick(async () => {
          await this.loadCatalog(true);
        }));
    }

    // Custom model text field; an empty ID is never saved.
    if (this.editingCustomModel) {
      new Setting(containerEl)
        .setName("Custom model ID")
        .setDesc("Enter the full model identifier")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_PROVIDER_MODELS[s.provider])
            .setValue(s.model)
            .onChange(async (value) => {
              const id = value.trim();
              if (!id) return;
              s.model = id;
              await this.plugin.saveSettings();
            })
        );
    }
  }

  // ─── Thinking level ───────────────────────────────────────────────────────

  /** The selected model's catalog entry when it offers thinking levels. */
  private thinkingOptions(): ModelOption | undefined {
    const s = this.plugin.settings;
    const option = this.catalogModels?.find(m => m.value === s.model);
    return option?.reasoningEfforts?.length ? option : undefined;
  }

  private renderThinkingLevel(setting: Setting): void {
    const s = this.plugin.settings;
    const option = this.thinkingOptions();
    if (!option?.reasoningEfforts) return;
    const efforts = option.reasoningEfforts;
    setting
      .setName("Thinking level")
      .addDropdown((dropdown) => {
        dropdown.addOption("", option.defaultReasoningEffort ? `Default (${option.defaultReasoningEffort})` : "Default");
        for (const effort of efforts) dropdown.addOption(effort, effort);
        // Keep a saved level this model doesn't offer; requests use the default.
        if (s.thinkingLevel && !resolveThinkingLevel(option, s.thinkingLevel)) {
          dropdown.addOption(s.thinkingLevel, `${s.thinkingLevel} (not available)`);
        }
        dropdown.setValue(s.thinkingLevel);
        dropdown.onChange(async (value) => {
          s.thinkingLevel = value;
          await this.plugin.saveSettings();
          this.update();
        });
      });
  }

  /** The account the settings are for (see `secretIdentity()`); empty when not set up. */
  private credentialIdentity(): string {
    const s = this.plugin.settings;
    return secretIdentity(s.provider, s.apiKey, () => this.plugin.chatgptOAuth.getCredential());
  }

  private async loadCatalog(force: boolean): Promise<void> {
    if (this.loadingCatalog || this.apiKeyEditing) return;
    const s = this.plugin.settings;
    const provider = s.provider;
    const secretIdentity = this.credentialIdentity();
    if (!secretIdentity) return;
    this.loadingCatalog = true;
    const current = () => s.provider === provider && this.credentialIdentity() === secretIdentity;
    let changed = false;
    try {
      const identity = await catalogIdentity(provider, secretIdentity);
      if (!current()) return;
      const state = s.modelCatalog;
      const cached = cachedCatalog(state, provider, identity);
      if (this.catalogIdentity !== identity) {
        this.catalogIdentity = identity;
        this.catalogModels = cached?.models;
        this.catalogError = "";
        changed = true;
      }
      if (changed && cached) this.update();
      if (!force && cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < CATALOG_TTL) return;
      const models = await refreshCatalog(state, provider, identity, s.apiKey, this.plugin.chatgptOAuth, force);
      if (!current()) return;
      if (models.length && this.catalogModels !== models) {
        this.catalogModels = models;
        changed = true;
        await this.plugin.saveSettings();
      }
      this.catalogError = "";
      if (force) new Notice(`Loaded ${models.length} models`);
    } catch (error) {
      if (current()) {
        this.catalogError = "Could not refresh models. Keeping the last list; use refresh to retry.";
        changed = true;
        if (force) new Notice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.loadingCatalog = false;
      if (current() && (changed || force)) this.update();
      else if (!current()) this.update();
    }
  }

}

// ─── Sign-in modal ──────────────────────────────────────────────────────────

/**
 * Shown once, after the first ChatGPT sign-in (OpenAI's UI guidelines for
 * "Sign in with ChatGPT").
 */
class ChatGPTPlanWelcomeModal extends Modal {
  onOpen(): void {
    const { contentEl } = this;
    new Setting(contentEl).setName("You're using your ChatGPT plan").setHeading();
    const text = contentEl.createEl("p", { text: "Chats in this plugin now use your ChatGPT plan. You can review and manage usage in " });
    text.createEl("a", { text: "ChatGPT settings", href: USAGE_URL });
    text.appendText(".");
    const ok = contentEl.createEl("button", { text: "Got it", cls: "mod-cta" });
    ok.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ChatGPTSignInModal extends Modal {
  /** Set by a press on the dimmed background, whose close request is ignored. */
  private backgroundPressed = false;

  constructor(
    app: App,
    private readonly oauth: ChatGPTOAuthService,
    private readonly onComplete: () => void,
    private options: SignInOptions = {},
  ) {
    super(app);
  }

  /**
   * Stays open on clicks outside the dialog: users switch to the browser and
   * back, and a stray click lost the dialog. Escape and the close button
   * still close it.
   */
  close(): void {
    if (this.backgroundPressed) {
      this.backgroundPressed = false;
      return;
    }
    super.close();
  }

  onOpen(): void {
    this.containerEl.querySelector(".modal-bg")?.addEventListener("pointerdown", () => {
      this.backgroundPressed = true;
      // Clear it if the press didn't turn into a close request.
      window.setTimeout(() => { this.backgroundPressed = false; }, 500);
    }, { capture: true });
    this.render();
  }

  /** The attempt for the current options: the same one until it is used or 10 minutes old. */
  private attempt(): PendingSignIn {
    return this.oauth.beginSignIn(this.options);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const pending = this.attempt();
    new Setting(contentEl).setName(this.options.newAccount ? "Use another ChatGPT account" : "Continue with ChatGPT").setHeading();
    if (this.options.newAccount && this.oauth.getCredential()) {
      contentEl.createEl("p", { text: "Sign in with the other account. The current account stays connected until then." });
    }
    if (this.options.consent) {
      contentEl.createEl("p", { text: "On the sign-in page, allow use of your ChatGPT plan." });
    }

    const step1 = contentEl.createEl("p", { text: "1. " });
    const link = step1.createEl("a", { text: "Open the sign-in page", href: pending.url });
    // An expired attempt is replaced when the page is opened.
    link.addEventListener("click", () => { link.href = this.attempt().url; });
    step1.appendText(" and sign in.");
    const open = contentEl.createEl("button", { text: "Open sign-in page", cls: "mod-cta" });
    open.addEventListener("click", () => {
      window.open(this.attempt().url, "_blank");
    });

    contentEl.createEl("p", {
      text: "2. The browser then shows a page that won't load. Copy its address and paste it here.",
    });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "chatting-minus-signin-input",
      attr: { placeholder: "http://127.0.0.1:…/auth/callback?code=…", "aria-label": "Paste the address of the page you land on" },
    });
    const status = contentEl.createEl("p", { cls: "chatting-minus-signin-error" });
    const connect = contentEl.createEl("button", { text: "Connect", cls: "mod-cta" });
    const consent = contentEl.createEl("button", { text: "Try again and allow ChatGPT plan use" });
    consent.hide();
    consent.addEventListener("click", () => {
      this.options = { ...this.options, consent: true };
      this.render();
      window.open(this.attempt().url, "_blank");
    });
    connect.addEventListener("click", () => {
      connect.disabled = true;
      status.setText("");
      consent.hide();
      this.oauth.completeSignIn(input.value)
        .then(() => {
          this.close();
          this.onComplete();
        })
        .catch((e: unknown) => {
          status.setText(e instanceof Error ? e.message : String(e));
          if (e instanceof ChatGPTOAuthError && e.planNotAllowed) consent.show();
          connect.disabled = false;
        });
    });

    // A returning sign-in reuses the registered account's client.
    if (!this.options.newAccount && pending.clientId !== NEW_REGISTRATION_CLIENT_ID) {
      const other = contentEl.createEl("p", { text: "A different ChatGPT account? " });
      const switchLink = other.createEl("a", { text: "Use another account", href: "#" });
      switchLink.addEventListener("click", (event) => {
        event.preventDefault();
        this.options = { ...this.options, newAccount: true };
        this.render();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
