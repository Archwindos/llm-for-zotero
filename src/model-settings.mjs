import { PROVIDERS, GEMINI_LEVELS, DEEPSEEK_EFFORTS, normalizeProfile } from "./profiles.mjs";
import { EFFORTS } from "./core.mjs";
import { providerModels } from "./providers.mjs";

export class ModelSettings {
  constructor(panel) {
    this.panel = panel; this.host = panel.host; this.window = panel.window; this.auth = panel.auth;
    this.el = panel.el.bind(panel); this.row = panel.row.bind(panel); this.label = panel.label.bind(panel);
    this.catalogs = new Map(); this.pending = null; this.disposed = false;
    this.root = this.el("section", { class: "gptz-model-settings", "aria-label": "模型配置" }); this.root.hidden = true;
    const button = (label, fn, attrs = {}) => panel.button(label, fn, attrs, false);
    this.select = this.el("select", { "aria-label": "已保存配置" });
    this.select.addEventListener("change", () => panel.run(() => this.edit(this.select.value)));
    this.name = this.el("input", { "aria-label": "配置名称", maxlength: "100", placeholder: "例如：Gemini 精读 / DeepSeek 快速翻译" });
    this.provider = this.el("select", { "aria-label": "模型厂家" });
    this.provider.append(...PROVIDERS.map(p => this.el("option", { value: p.id }, p.name)));
    this.provider.addEventListener("change", () => panel.run(() => {
      this.cancelPending(); this.key.value = "";
      this.draft.provider = this.provider.value; this.draft.model = ""; this.draft.options = {};
      this.fillOptions(); this.refreshConnections(); this.renderModels(); this.ensureModels();
    }));
    this.key = this.el("input", { type: "password", autocomplete: "off", "aria-label": "厂家 API Key", placeholder: "粘贴此厂家的 API Key" });
    this.keyLabel = this.label("API Key", this.key);
    this.account = this.el("select", { "aria-label": "ChatGPT 账号" });
    this.account.addEventListener("change", () => panel.run(() => {
      this.cancelPending(); this.auth.select(this.account.value); this.renderModels(); this.ensureModels();
    }));
    this.login = button("登录 ChatGPT", () => this.signIn(), { class: "gptz-login" });
    this.cancelLogin = button("取消登录", () => this.auth.pending?.cancel());
    this.addAccount = button("添加账号", () => this.signIn(true));
    this.logout = button("退出账号", async () => {
      this.cancelPending();
      const revoked = await this.auth.signOut(); this.catalogs.clear(); this.refreshConnections(); this.renderModels();
      panel.status(revoked ? "已退出 ChatGPT。" : "本机已退出；可在 ChatGPT 中确认应用已断开。", !revoked);
    });
    this.accountPane = this.el("div", { class: "gptz-account" });
    this.accountPane.append(this.account, this.login, this.row(this.cancelLogin, this.addAccount, this.logout));
    this.connect = button("保存密钥并读取模型", () => this.connectProvider(), { class: "gptz-connect" });
    this.connection = this.el("p", { class: "gptz-muted", role: "status" });
    this.model = this.el("select", { "aria-label": "配置模型" });
    this.model.addEventListener("change", () => { this.draft.model = this.model.value; });
    this.openaiOptions = this.el("div");
    this.openaiEffort = this.efforts("OpenAI 思考强度", EFFORTS);
    this.fast = this.el("input", { type: "checkbox", "aria-label": "OpenAI Fast" });
    this.openaiOptions.append(this.label("思考强度", this.openaiEffort), panel.checkboxLabel("Fast", this.fast),
      this.el("p", { class: "gptz-muted" }, "Fast 可能消耗更多额度，是否采用以服务端返回为准。"));
    this.deepseekOptions = this.el("div");
    this.thinking = this.el("input", { type: "checkbox", "aria-label": "DeepSeek 深度思考" });
    this.deepseekEffort = this.efforts("DeepSeek 思考强度", DEEPSEEK_EFFORTS);
    this.thinking.addEventListener("change", () => { this.deepseekEffort.disabled = !this.thinking.checked; });
    this.deepseekOptions.append(panel.checkboxLabel("深度思考", this.thinking), this.label("思考强度", this.deepseekEffort),
      this.el("p", { class: "gptz-muted" }, "关闭深度思考适合即时翻译。不会启用联网搜索。"));
    this.geminiOptions = this.el("div");
    this.geminiEffort = this.efforts("Gemini 思考强度", GEMINI_LEVELS);
    this.geminiOptions.append(this.label("思考强度", this.geminiEffort),
      this.el("p", { class: "gptz-muted" }, "Gemini 3.8 Flash 支持 low、medium、high。不会启用联网搜索。"));
    this.save = button("保存配置", () => this.saveProfile(), { class: "gptz-primary" });
    this.remove = button("删除配置", () => {
      this.host.deleteProfile(this.draft.id); this.edit(this.host.profiles()[0].id); panel.status("配置已删除。");
    });
    this.root.append(this.row(button("返回对话", () => this.close()), this.el("strong", {}, "模型配置")),
      this.el("p", { class: "gptz-muted" }, "每个配置保存一组厂家、模型和参数；翻译与问答分别选择。"),
      this.label("已存配置", this.select), this.row(button("新增配置", () => this.create()), this.remove),
      this.label("配置名称", this.name), this.label("厂家", this.provider), this.keyLabel, this.accountPane,
      this.connect, this.connection, this.label("模型", this.model), this.openaiOptions, this.deepseekOptions, this.geminiOptions,
      this.row(this.save), this.el("p", { class: "gptz-muted" }, "密钥由同厂家配置共用，保存在 Zotero 登录管理器。保存配置后，在设置里分配给翻译或问答。"));
  }
  efforts(label, values) {
    const select = this.el("select", { "aria-label": label });
    select.append(...values.map(v => this.el("option", { value: v }, v === "default" ? "默认" : v))); return select;
  }
  open(id = this.host.taskProfile("chat").id) {
    this.root.hidden = false; this.panel.chatView.hidden = true;
    this.panel.settingsButton.setAttribute("aria-expanded", "true"); this.edit(id);
  }
  close() {
    this.cancelPending(); this.key.value = "";
    this.root.hidden = true; this.panel.chatView.hidden = false; this.panel.openSettings(false);
  }
  create() {
    this.cancelPending(); this.key.value = "";
    this.draft = { id: this.window.crypto.randomUUID(), name: "", provider: "gemini", model: "", options: {} };
    this.select.value = ""; this.name.value = ""; this.provider.value = "gemini"; this.remove.disabled = true;
    this.fillOptions(); this.refreshConnections(); this.renderModels(); this.ensureModels(); this.name.focus();
  }
  edit(id) {
    const profiles = this.host.profiles(), profile = profiles.find(p => p.id === id);
    if (!profile) throw new Error("找不到此模型配置。");
    this.cancelPending(); this.key.value = "";
    this.draft = normalizeProfile(profile);
    this.select.replaceChildren(...profiles.map(p => this.el("option", { value: p.id }, p.name)));
    this.select.value = id; this.name.value = profile.name; this.provider.value = profile.provider; this.remove.disabled = false;
    this.fillOptions(); this.refreshConnections(); this.renderModels(); this.ensureModels();
  }
  fillOptions() {
    const provider = this.draft.provider, options = this.draft.options;
    this.openaiOptions.hidden = !["openai", "chatgpt"].includes(provider);
    this.deepseekOptions.hidden = provider !== "deepseek"; this.geminiOptions.hidden = provider !== "gemini";
    this.openaiEffort.value = options.effort || "medium"; this.fast.checked = options.fast === true;
    this.thinking.checked = options.thinking === true; this.deepseekEffort.value = options.effort || "high";
    this.deepseekEffort.disabled = !this.thinking.checked; this.geminiEffort.value = options.thinkingLevel || "high";
  }
  refreshConnections() {
    if (this.disposed || !this.draft) return;
    const isAccount = this.draft.provider === "chatgpt", current = this.auth.current(), pending = !!this.auth.pending;
    this.keyLabel.hidden = isAccount; this.accountPane.hidden = !isAccount;
    const connected = isAccount ? !!current?.access_token : !!this.host.getKey(this.draft.provider);
    this.key.placeholder = connected ? "已保存；留空保留原密钥" : "粘贴此厂家的 API Key";
    this.connect.textContent = isAccount ? "读取账号模型" : connected ? "更新密钥 / 刷新模型" : "保存密钥并读取模型";
    this.connect.disabled = !!this.pending || (isAccount && !connected);
    this.key.disabled = !!this.pending;
    this.login.textContent = connected ? "重新登录 ChatGPT" : "Continue with ChatGPT";
    this.login.disabled = pending; this.cancelLogin.hidden = !pending;
    this.logout.hidden = !current?.access_token; this.addAccount.hidden = !this.auth.accounts().length;
    this.account.replaceChildren(...this.auth.accounts().map(a => this.el("option", { value: a.client_id }, `${a.email}${a.connected ? "" : "（已退出）"}`)));
    this.account.value = current?.client_id || ""; this.account.hidden = !this.auth.accounts().length;
    this.connection.textContent = this.pending ? "正在读取模型列表…" : connected ? isAccount ? `已登录 ${current.email}` : "此厂家的密钥已保存在本机。" : isAccount ? "请先登录 ChatGPT。" : "请保存此厂家的密钥。";
  }
  renderModels() {
    const models = this.catalogs.get(this.host.cacheIdentity(this.draft.provider)) || [];
    const saved = this.draft.model;
    const choices = models.map(m => this.el("option", { value: m.id }, m.name));
    if (saved && !models.some(m => m.id === saved)) choices.unshift(this.el("option", { value: saved }, `${saved}（已保存，待验证）`));
    if (!choices.length) choices.push(this.el("option", { value: "" }, "请先读取模型列表"));
    this.model.replaceChildren(...choices);
    const preferred = PROVIDERS.find(p => p.id === this.draft.provider).model;
    this.model.value = saved || models.find(m => m.id === preferred)?.id || models[0]?.id || "";
    this.draft.model = this.model.value; this.model.disabled = !!this.pending || !models.length;
  }
  ensureModels() {
    const provider = this.draft.provider;
    if (this.root.hidden || this.pending || this.catalogs.has(this.host.cacheIdentity(provider))) return;
    if (provider === "chatgpt" ? !this.auth.current()?.access_token : !this.host.getKey(provider)) return;
    this.panel.run(() => this.connectProvider());
  }
  async connectProvider() {
    if (this.pending || this.disposed || this.root.hidden) return;
    const provider = this.draft.provider, enteredKey = this.key.value.trim();
    const attempt = { request: null, cancel() { this.request?.cancel(); } };
    // Own the attempt before any await, including credential refresh or key storage.
    this.pending = attempt; this.key.value = ""; this.refreshConnections(); this.model.disabled = true;
    const current = () => !this.disposed && !this.root.hidden && this.pending === attempt && this.draft.provider === provider;
    try {
      if (provider !== "chatgpt" && enteredKey) await this.host.setKey(enteredKey, provider);
      if (!current()) return;
      const identity = this.host.cacheIdentity(provider);
      const key = await this.host.credential(provider);
      if (!current() || identity !== this.host.cacheIdentity(provider)) return;
      attempt.request = providerModels(this.window, key, provider);
      const models = await attempt.request.promise;
      if (!current() || identity !== this.host.cacheIdentity(provider)) return;
      if (!models.length) throw new Error("此账号未返回可用的文字模型。");
      this.catalogs.set(identity, models); this.renderModels(); this.panel.status(`已读取 ${models.length} 个模型。`);
    } catch (error) {
      if (current()) this.panel.status(error.message, true);
    } finally {
      if (this.pending === attempt) {
        this.pending = null;
        if (!this.disposed) { this.refreshConnections(); this.renderModels(); }
      }
    }
  }
  async signIn(addNew = false) {
    await this.auth.signIn(addNew ? undefined : this.auth.current()?.client_id);
    if (!this.disposed) { this.refreshConnections(); await this.connectProvider(); }
  }
  saveProfile() {
    if (!this.model.value) throw new Error("请读取模型列表并选择一个模型。");
    const provider = this.provider.value;
    const options = provider === "gemini" ? { thinkingLevel: this.geminiEffort.value }
      : provider === "deepseek" ? { thinking: this.thinking.checked, effort: this.deepseekEffort.value }
      : { effort: this.openaiEffort.value, fast: this.fast.checked };
    const saved = this.host.saveProfile({ id: this.draft.id, name: this.name.value, provider, model: this.model.value, options });
    this.edit(saved.id); this.panel.refreshProfiles(); this.panel.status("模型配置已保存。"); return saved;
  }
  cancelPending() { const attempt = this.pending; this.pending = null; attempt?.cancel(); }
  destroy() { this.disposed = true; this.cancelPending(); this.key.value = ""; }
}
