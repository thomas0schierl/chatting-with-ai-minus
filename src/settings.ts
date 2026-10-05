import { App, Modal, Notice, PluginSettingTab, Setting, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import type ChatPlugin from "./main";
import type { Provider } from "./types";
import { DEFAULT_PROVIDER_MODELS } from "./types";
import {
  ChatGPTOAuthError,
  NEW_REGISTRATION_CLIENT_ID,
  USAGE_URL,
  type ChatGPTOAuthService,
  type PendingSignIn,
  type SignInOptions,
} from "./auth/chatgptOAuth";

import { type ModelOption, type CatalogState, catalogIdentity, cachedCatalog, refreshCatalog, getCatalogModels, clearCatalogModels, catalogModel, resolveThinkingLevel, thinkingLevelLabel, CATALOG_TTL } from "./api/model-catalog";

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
  }

  // Obsidian 1.13+ indexes these definitions; older versions retain display().
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: "Provider", render: setting => this.renderProvider(setting) },
      { name: "API key", visible: () => this.plugin.settings.provider !== "chatgpt-oauth", render: setting => this.renderApiKeySection(setting.settingEl.parentElement!, setting) },
      { name: "ChatGPT account", visible: () => this.plugin.settings.provider === "chatgpt-oauth", render: setting => this.renderChatGPTOAuthSection(setting.settingEl.parentElement!, setting) },
      { name: "Model", aliases: ["Custom model ID", "Refresh models"], render: setting => {
        this.renderModelSection(setting.settingEl.parentElement!, setting);
        void this.loadCatalog(false);
      } },
      { name: "Thinking level", visible: () => !!this.thinkingOptions(), render: setting => this.renderThinkingLevel(setting) },
      { name: "Web search", render: setting => this.renderWebSearch(setting) },
      { name: "Max tool iterations", render: setting => this.renderMaxIterations(setting) },
    ];
  }

  hide(): void {
    super.hide();
    this.editingCustomModel = false;
  }

  private refreshSettingsTab(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    this.renderProvider(new Setting(containerEl));

    // ─── Auth section: API key OR OAuth Connect ───────────────────────
    if (s.provider === "chatgpt-oauth") {
      this.renderChatGPTOAuthSection(containerEl);
    } else {
      this.renderApiKeySection(containerEl);
    }

    // ─── Model ────────────────────────────────────────────────────────
    this.renderModelSection(containerEl);
    void this.loadCatalog(false);
    if (this.thinkingOptions()) this.renderThinkingLevel(new Setting(containerEl));

    this.renderWebSearch(new Setting(containerEl));
    this.renderMaxIterations(new Setting(containerEl));
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
            window.setTimeout(() => this.refreshSettingsTab(), 10);
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

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(containerEl: HTMLElement, row?: Setting): void {
    const s = this.plugin.settings;

    const apiKeySetting = (row ?? new Setting(containerEl))
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
              this.refreshSettingsTab();
            }, 800);
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const { sendMessage } = await import("./api/client");
            const response = await sendMessage(
              s,
              [{ role: "user", content: "Say hello in one word." }],
              [],
              "You are a test. Respond with one word."
            );
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
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

  private renderChatGPTOAuthSection(containerEl: HTMLElement, row?: Setting): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    if (credential) {
      (row ?? new Setting(containerEl))
        .setName("ChatGPT account")
        .setDesc(credential.email ? `Using your ChatGPT plan as ${credential.email}.` : "Using your ChatGPT plan.")
        .addButton((button) => button.setButtonText("Manage usage").onClick(() => {
          window.open(USAGE_URL, "_blank");
        }))
        .addButton((button) => button.setButtonText("Use another account").onClick(() => {
          new ChatGPTSignInModal(this.app, this.plugin.chatgptOAuth, () => this.refreshSettingsTab(), { newAccount: true }).open();
        }))
        .addButton((button) => {
          button
            .setButtonText("Disconnect")
            .onClick(async () => {
              const revoked = await this.plugin.chatgptOAuth.signOut();
              clearCatalogModels("chatgpt-oauth");
              this.catalogModels = undefined;
              this.catalogIdentity = "";
              if (this.plugin.settings.modelCatalog) {
                this.plugin.settings.modelCatalog.entries = this.plugin.settings.modelCatalog.entries.filter(e => e.provider !== "chatgpt-oauth");
                await this.plugin.saveSettings();
              }
              new Notice(revoked
                ? "ChatGPT disconnected."
                : "Disconnected on this device. OpenAI didn't confirm the sign-out; you can remove the app in ChatGPT settings.");
              this.refreshSettingsTab();
            });
          if (requireApiVersion("1.13.0")) button.setDestructive();
          else button.setWarning();
        })
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              const { sendMessage } = await import("./api/client");
              const response = await sendMessage(
                this.plugin.settings,
                [{ role: "user", content: "Say hello in one word." }],
                [],
                "You are a test. Respond with one word."
              );
              const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
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
      (row ?? new Setting(containerEl))
        .setName("ChatGPT account")
        .setDesc("Use your ChatGPT plan instead of an API key.")
        .addButton((button) =>
          button
            .setButtonText("Continue with ChatGPT")
            .setCta()
            .onClick(() => {
              new ChatGPTSignInModal(this.app, this.plugin.chatgptOAuth, () => this.refreshSettingsTab()).open();
            })
        );
    }
  }

  // ─── Model picker ─────────────────────────────────────────────────────────

  private renderModelSection(containerEl: HTMLElement, row?: Setting): void {
    const s = this.plugin.settings;
    const cached = this.catalogModels;
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = (row ?? new Setting(containerEl))
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
            this.refreshSettingsTab();
            return;
          }
          this.editingCustomModel = false;
          s.model = value;
          await this.plugin.saveSettings();
          // The thinking levels on offer depend on the model.
          this.refreshSettingsTab();
        });
      });

    const canFetchModels = s.provider === "chatgpt-oauth" ? !!this.plugin.chatgptOAuth.getCredential() : !!s.apiKey;
    if (canFetchModels) {
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
          this.refreshSettingsTab();
        });
      });
  }

  private credentialIdentity(): string {
    const s = this.plugin.settings;
    if (s.provider !== "chatgpt-oauth") return s.apiKey;
    const credential = this.plugin.chatgptOAuth.getCredential();
    return credential ? credential.accountId || credential.accessToken : "";
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
      const state: CatalogState = s.modelCatalog ??= { entries: [] };
      const cached = cachedCatalog(state, provider, identity);
      if (this.catalogIdentity !== identity) {
        this.catalogIdentity = identity;
        this.catalogModels = cached?.models;
        this.catalogError = "";
        changed = true;
      }
      if (changed && cached) this.refreshSettingsTab();
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
      if (current() && (changed || force)) this.refreshSettingsTab();
      else if (!current()) this.refreshSettingsTab();
    }
  }

}

// ─── Sign-in modal ──────────────────────────────────────────────────────────

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

    const step1 = contentEl.createEl("p", { text: "1. Sign in on the " });
    const link = step1.createEl("a", { text: "sign-in page", href: pending.url });
    // An expired attempt is replaced when the page is opened.
    link.addEventListener("click", () => { link.href = this.attempt().url; });
    step1.appendText(".");
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
          new Notice("ChatGPT connected. Chats now use your ChatGPT plan.");
          this.onComplete();
          this.close();
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
