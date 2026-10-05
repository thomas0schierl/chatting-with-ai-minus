import { App, Modal, Notice, PluginSettingTab, Setting, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import type ChatPlugin from "./main";
import type { Provider } from "./types";
import { DEFAULT_PROVIDER_MODELS } from "./types";
import type { ChatGPTDeviceAuthorization, PollHandle } from "./auth/chatgptOAuth";

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
  // CLI catalog entries are not guaranteed to be available to every account.
  // Keep the default confirmed by user reports; other IDs remain customizable.
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

    const explainer = containerEl.createDiv({
      cls: "setting-item-description chatting-minus-oauth-explainer",
    });
    if (row) row.settingEl.before(explainer);
    explainer.createSpan({
      text: "Sign in with your ChatGPT account instead of using an OpenAI API key. Requests are routed through the ChatGPT/Codex backend (not ",
    });
    explainer.createEl("code", { text: "api.openai.com" });
    explainer.createSpan({
      text: ") and require an active ChatGPT plan with Codex access. Refresh the model list to see the catalog for your account. Listed models may still depend on account permissions.",
    });

    if (credential) {
      const account = credential.accountId
        ? maskAccountId(credential.accountId)
        : "(no account id)";
      const expires = new Date(credential.expiresAt).toLocaleString();
      (row ?? new Setting(containerEl))
        .setName("ChatGPT account")
        .setDesc(`Connected — account ${account}. Token expires ${expires}.`)
        .addButton((button) => {
          button
            .setButtonText("Disconnect")
            .onClick(async () => {
              this.plugin.chatgptOAuth.clearCredential();
              clearCatalogModels("chatgpt-oauth");
              this.catalogModels = undefined;
              this.catalogIdentity = "";
              if (this.plugin.settings.modelCatalog) {
                this.plugin.settings.modelCatalog.entries = this.plugin.settings.modelCatalog.entries.filter(e => e.provider !== "chatgpt-oauth");
                await this.plugin.saveSettings();
              }
              new Notice("ChatGPT OAuth disconnected.");
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
        .setDesc("Not connected. Sign in with ChatGPT to use this provider.")
        .addButton((button) =>
          button
            .setButtonText("Connect ChatGPT")
            .setCta()
            .onClick(async () => {
              try {
                const auth = await this.plugin.chatgptOAuth.beginDeviceAuthorization();
                const handle = this.plugin.chatgptOAuth.pollDeviceAuthorization(auth);
                const modal = new ChatGPTDeviceLoginModal(this.app, auth, handle, () => {
                  this.refreshSettingsTab();
                });
                modal.open();
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`Failed to start ChatGPT login: ${msg}`);
              }
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

// ─── Device-flow login modal ────────────────────────────────────────────────

class ChatGPTDeviceLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly authorization: ChatGPTDeviceAuthorization,
    private readonly handle: PollHandle,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Connect ChatGPT").setHeading();

    contentEl.createEl("p", {
      text: "1. Open this page in any browser:",
    });
    const linkRow = contentEl.createDiv({ cls: "chatting-minus-device-link-row" });
    const link = linkRow.createEl("a", {
      text: this.authorization.verificationUri,
      href: this.authorization.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: "2. Enter this code on the page:" });
    const codeRow = contentEl.createDiv({ cls: "chatting-minus-device-code-row" });

    codeRow.createEl("code", {
      text: this.authorization.userCode,
      cls: "chatting-minus-device-code",
    });

    const copyBtn = codeRow.createEl("button", { text: "Copy code" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.authorization.userCode)
        .then(() => new Notice("Code copied."))
        .catch(() => new Notice("Failed to copy code."));
    });

    const status = contentEl.createEl("p", {
      text: "Waiting for authorization. You can return here after signing in.",
      cls: "chatting-minus-device-status",
    });

    const buttons = contentEl.createDiv({ cls: "chatting-minus-device-buttons" });

    const openBtn = buttons.createEl("button", { text: "Open login page" });
    openBtn.classList.add("mod-cta");
    openBtn.addEventListener("click", () => {
      window.open(this.authorization.verificationUri, "_blank");
    });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.cancelled = true;
      this.handle.cancel();
      this.close();
    });

    // Wait for the poll to finish.
    this.handle.promise
      .then(() => {
        if (this.cancelled) return;
        new Notice("ChatGPT connected.");
        this.onComplete();
        this.close();
      })
      .catch((e: unknown) => {
        if (this.cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`Login failed: ${msg}`);
        status.removeClass("chatting-minus-device-status");
        status.addClass("chatting-minus-device-status-error");
      });
  }

  onClose(): void {
    if (!this.cancelled) {
      // If the user closed via Esc / outside click, treat it as cancel.
      this.handle.cancel();
    }
    this.contentEl.empty();
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}
