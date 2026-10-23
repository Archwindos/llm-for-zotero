import createDOMPurify from "dompurify";
import { renderRichText } from "./render.mjs";
import { buildPrompt, buildUserMessage, makeContext, tierLabel, noteMarkdown } from "./core.mjs";
import { streamModel, assertPDFSupport } from "./providers.mjs";
import { providerName, profileSummary } from "./profiles.mjs";
import { ModelSettings } from "./model-settings.mjs";

const HTML = "http://www.w3.org/1999/xhtml";

export class Panel {
  constructor(window, host, rootURI, version = "0.6.2") {
    this.window = window; this.doc = window.document; this.host = host; this.auth = host.auth; this.rootURI = rootURI;
    this.context = null; this.chatContext = null; this.messages = []; this.pending = null; this.busy = false; this.disposed = false; this.settingsOpen = false;
    host.profiles();
    this.purify = createDOMPurify(window); this.controls = []; this.nodes = [];
    const link = this.el("link"); link.rel = "stylesheet"; link.href = rootURI + `panel.css?v=${version}`;
    this.doc.documentElement.append(link); this.nodes.push(link);
    const mathStyle = this.el("link", { rel: "stylesheet", href: rootURI + "vendor/katex/katex.min.css" });
    this.doc.documentElement.append(mathStyle); this.nodes.push(mathStyle);
    this.splitter = this.doc.createXULElement("splitter"); this.splitter.id = "gptz-splitter";
    this.root = this.el("section", { id: "gptz-panel", "aria-label": "LLM for Zotero" });
    this.root.style.width = `${Math.max(360, Math.min(900, host.getPref("width", 440)))}px`;
    const parent = this.doc.getElementById("browser");
    if (!parent) throw new Error("未找到 Zotero 主界面容器。");
    parent.append(this.splitter, this.root); this.nodes.push(this.splitter, this.root);
    this.build(); this.identity = host.profileIdentity(host.taskProfile("chat"));
    this.unsubscribe = this.auth.subscribe(() => {
      if (this.disposed) return;
      this.run(() => {
        const profile = this.host.taskProfile("chat"), identity = this.host.profileIdentity(profile);
        if (identity !== this.identity || (profile.provider === "chatgpt" && this.auth.signingOut)) {
          this.pending?.cancel(); this.identity = identity; this.resetChat(true);
        }
        this.refreshProfiles(); this.models.refreshConnections();
      });
    });
    this.show(false);
  }
  el(tag, attrs = {}, text) {
    const node = this.doc.createElementNS(HTML, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  button(text, fn, attrs = {}, lock = true) {
    const b = this.el("button", { type: "button", ...attrs }, text);
    b.addEventListener("click", () => this.run(fn)); if (lock) this.controls.push(b); return b;
  }
  async run(fn) { try { await fn(); } catch (error) { this.status(error.message || "操作失败，请重试。", true); } }
  row(...nodes) { const row = this.el("div", { class: "gptz-row" }); row.append(...nodes); return row; }
  label(text, input) { const label = this.el("label", { class: "gptz-label" }); label.append(this.el("span", {}, text), input); return label; }
  checkboxLabel(text, input) { const label = this.el("label", { class: "gptz-toggle" }); label.append(input, this.el("span", {}, text)); return label; }
  status(text, error = false) {
    this.window.clearTimeout(this.statusTimer);
    if (!this.disposed) {
      this.statusBox.textContent = text; this.statusBox.classList.toggle("error", error);
      if (text && !error) this.statusTimer = this.window.setTimeout(() => { if (!this.disposed && !this.busy) this.statusBox.textContent = ""; }, 4000);
    }
  }
  build() {
    const header = this.el("header", { class: "gptz-header" });
    const brand = this.row(this.el("img", { src: this.rootURI + "icons/llm.svg", alt: "", width: "24", height: "24" }), this.el("strong", {}, "LLM for Zotero"));
    this.settingsButton = this.button("设置", () => this.openSettings(!this.settingsOpen), { class: "gptz-settings-toggle", "aria-expanded": "false", "aria-label": "设置", "aria-controls": "gptz-settings" });
    this.newChatButton = this.button("✎", () => { this.resetChat(); this.openHistory(false); }, { class: "gptz-icon", "aria-label": "新对话", title: "新对话" });
    this.historyButton = this.button("◷", () => this.openHistory(this.historyView.hidden), { class: "gptz-icon", "aria-label": "历史对话", title: "历史对话", "aria-expanded": "false" });
    header.append(brand, this.row(this.historyButton, this.newChatButton, this.settingsButton,
      this.button("×", () => this.show(false), { class: "gptz-icon", "aria-label": "收起侧栏" }, false)));
    this.chatView = this.el("div", { class: "gptz-chat-view" });
    this.settings = this.el("section", { id: "gptz-settings", class: "gptz-settings", "aria-label": "功能设置" });
    this.autoTranslate = this.el("input", { type: "checkbox", "aria-label": "划词自动翻译" }); this.autoTranslate.checked = this.host.getPref("autoTranslate", true);
    this.autoTranslate.addEventListener("change", () => this.host.setPref("autoTranslate", this.autoTranslate.checked));
    this.translationProfile = this.el("select", { "aria-label": "翻译配置" });
    this.chatRoute = this.el("select", { "aria-label": "设置中的问答配置" });
    this.translationProfile.addEventListener("change", () => this.run(() => this.host.setPref("translationProfileID", this.translationProfile.value)));
    this.chatRoute.addEventListener("change", () => this.run(() => this.host.setPref("chatProfileID", this.chatRoute.value)));
    this.settings.append(this.row(this.checkboxLabel("自动翻译", this.autoTranslate)), this.label("划词翻译", this.translationProfile), this.label("对话问答", this.chatRoute),
      this.button("模型配置", () => this.openModelSettings(), { class: "gptz-configure" }),
      this.el("p", { class: "gptz-muted" }, "默认阅读习惯：读论文 · 讲原理 · 说人话"));
    this.chatView.append(this.settings);
    this.transcript = this.el("div", { class: "gptz-transcript", "aria-label": "对话" }); this.chatView.append(this.transcript);
    this.followOutput = true; this.lastScrollTop = 0;
    this.transcript.addEventListener("scroll", () => {
      const top = this.transcript.scrollTop;
      // A formula reflow can shorten the bottom gap before this event arrives.
      if (top < this.lastScrollTop - 1) this.followOutput = false;
      else if (top > this.lastScrollTop + 1) this.followOutput = this.nearBottom();
      this.lastScrollTop = top;
    });
    this.compose = this.el("div", { class: "gptz-compose" });
    this.attachment = this.el("div", { class: "gptz-attachment" }); this.attachment.hidden = true;
    this.contextLabel = this.el("span", { class: "gptz-attachment-title" });
    this.contextInfo = this.el("span", { class: "gptz-attachment-meta" });
    this.contextButton = this.button("", () => this.openMaterialPreview(this.materialPreview.hidden), { class: "gptz-attachment-open", "aria-label": "查看论文材料", "aria-expanded": "false", "aria-controls": "gptz-material-preview" });
    const attachmentText = this.el("span", { class: "gptz-attachment-text" }); attachmentText.append(this.contextLabel, this.contextInfo);
    this.contextIcon = this.el("span", { class: "gptz-attachment-icon", "aria-hidden": "true" }, "❞");
    this.contextButton.append(this.contextIcon, attachmentText);
    this.attachment.append(this.contextButton, this.button("×", () => this.clearContext(), { class: "gptz-attachment-remove", "aria-label": "移除论文材料", title: "移除材料" }));
    this.materialPreview = this.el("section", { id: "gptz-material-preview", class: "gptz-material-preview", role: "region", "aria-label": "材料预览" }); this.materialPreview.hidden = true;
    this.previewClose = this.button("×", () => { this.openMaterialPreview(false); this.contextButton.focus(); }, { class: "gptz-icon", "aria-label": "关闭材料预览" }, false);
    this.preview = this.el("div", { class: "gptz-source-text", "aria-label": "论文原文" });
    this.materialPreview.append(this.row(this.el("strong", {}, "论文材料"), this.previewClose), this.preview);
    this.addButton = this.button("＋", () => this.openAddMenu(this.addMenu.hidden), { class: "gptz-add", title: "添加材料", "aria-label": "添加材料", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "gptz-add-menu" });
    this.addMenu = this.el("div", { id: "gptz-add-menu", class: "gptz-add-menu", role: "menu", "aria-label": "添加材料方式" }); this.addMenu.hidden = true;
    for (const [title, kind] of [["当前 PDF 文件", "pdf"], ["当前文献摘要", "abstract"], ["粘贴为论文材料", "paste"]]) {
      this.addMenu.append(this.button(title, async () => {
        this.closeExtras(); if (kind === "paste") await this.pasteContext(); else await this.loadContext(kind);
      }, { role: "menuitem", "data-context-kind": kind }));
    }
    this.addMenu.addEventListener("keydown", event => {
      const buttons = [...this.addMenu.querySelectorAll("button")], index = buttons.indexOf(this.doc.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length; buttons[next].focus();
      } else if (event.key === "Tab") {
        event.preventDefault(); this.closeExtras(); (event.shiftKey ? this.addButton : this.question).focus();
      }
    });
    this.compose.addEventListener("keydown", event => {
      if (event.key === "Escape" && (!this.addMenu.hidden || !this.materialPreview.hidden)) {
        event.preventDefault(); event.stopPropagation(); this.closeExtras(); this.question.focus();
      }
    });
    this.outsideClick = event => { if (!this.compose.contains(event.target)) this.closeExtras(); };
    this.doc.addEventListener("pointerdown", this.outsideClick);
    this.question = this.el("textarea", { rows: "2", "aria-label": "你的问题", placeholder: "询问这篇论文…" });
    this.question.addEventListener("input", () => this.resizeQuestion());
    this.question.addEventListener("focus", () => this.closeExtras());
    this.question.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.metaKey) { e.preventDefault(); this.run(() => this.send()); }
    });
    this.chatProfile = this.el("select", { "aria-label": "问答配置", class: "gptz-chat-profile" });
    this.chatProfile.addEventListener("change", () => this.run(() => this.host.setPref("chatProfileID", this.chatProfile.value)));
    this.controls.push(this.question, this.chatProfile, this.chatRoute, this.translationProfile, this.autoTranslate);
    this.sendButton = this.button("↑", () => this.send(), { class: "gptz-send gptz-primary", title: "发送 · Enter", "aria-label": "发送" });
    this.stopButton = this.button("■", () => { this.cancelRequested = true; this.pending?.cancel(); }, { class: "gptz-send", "aria-label": "停止生成" }, false); this.stopButton.hidden = true;
    this.options = this.row(this.addButton, this.chatProfile, this.sendButton, this.stopButton); this.options.classList.add("gptz-options");
    this.compose.append(this.attachment, this.question, this.options, this.addMenu, this.materialPreview);
    this.connectionLabel = this.el("span"); this.usageButton = this.button("管理用量", () => this.host.openExternal("https://chatgpt.com/settings/usage"), { class: "gptz-link" }, false);
    this.settings.append(this.row(this.connectionLabel, this.usageButton));
    this.chatView.append(this.compose);
    this.models = new ModelSettings(this);
    this.buildHistory(); this.buildNoteEditor();
    this.statusBox = this.el("div", { class: "gptz-status", role: "status", "aria-live": "polite" });
    this.root.append(header, this.chatView, this.historyView, this.noteView, this.models.root, this.statusBox);
    this.resetChat(); this.contextChanged(); this.refreshProfiles();
  }
  refreshProfiles() {
    const profiles = this.host.profiles();
    for (const [select, task] of [[this.translationProfile, "translation"], [this.chatRoute, "chat"], [this.chatProfile, "chat"]]) {
      const profile = this.host.taskProfile(task);
      select.replaceChildren(...profiles.map(p => this.el("option", { value: p.id, title: profileSummary(p) }, p.name)));
      select.value = profile.id; select.title = profileSummary(profile); select.disabled = this.busy;
    }
    const profile = this.host.taskProfile("chat");
    const connected = profile.provider === "chatgpt" ? !!this.auth.current()?.access_token : !!this.host.getKey(profile.provider);
    this.connectionLabel.textContent = `${providerName(profile.provider)}${connected ? "" : " · 待连接"}`;
    this.usageButton.hidden = profile.provider !== "chatgpt";
    this.sendButton.disabled = this.busy;
    for (const control of [this.newChatButton, this.historyButton, this.settingsButton]) control.disabled = this.busy || (this.noteView && !this.noteView.hidden);
  }
  openSettings(open = true) {
    this.closeExtras();
    if (this.historyView && !this.historyView.hidden) this.openHistory(false);
    if (!this.models.root.hidden) { this.models.close(); return; }
    this.settingsOpen = open; this.settings.hidden = !open; this.settingsButton.setAttribute("aria-expanded", String(open));
    if (open) this.refreshProfiles();
  }
  openModelSettings(task = "chat") {
    if (this.busy) throw new Error("请先停止当前回答，再修改模型配置。");
    this.models.open(this.host.taskProfile(task).id);
  }
  show(visible = true) {
    this.root.hidden = !visible; this.splitter.hidden = !visible;
    if (!visible) { this.closeExtras(); if (this.noteView.hidden) { this.models.close(); this.openSettings(false); } }
    if (visible) { this.refreshProfiles(); this.resizeQuestion(); (this.noteView.hidden ? this.question : this.noteEditor).focus(); }
  }
  toggle() { this.show(this.root.hidden); }
  async loadContext(kind, selection) {
    if (this.busy) throw new Error("请先等待当前操作结束。");
    this.setBusy(true); this.status("正在读取本地材料…");
    try {
      const context = await this.host.context(kind, selection); if (this.disposed) return;
      const replacedPDF = context.type === "pdf" && this.messages.some(m => m.pdf?.attachmentID === context.attachmentID &&
        (m.pdf.attachmentKey !== context.attachmentKey || m.pdf.attachmentLibraryID !== context.attachmentLibraryID || m.pdf.size !== context.size || m.pdf.modifiedTime !== context.modifiedTime));
      if (((this.context || this.chatContext)?.itemID !== context.itemID || replacedPDF) && this.messages.length) this.resetChat(true);
      this.context = context; this.contextChanged(); this.closeExtras();
      this.status(context.type === "pdf" ? `${replacedPDF ? "PDF 已更新，已开始新对话。" : ""}已添加 PDF 原文件，点击发送后交给当前模型。` : "");
    } finally { this.setBusy(false); if (!this.disposed && !this.root.hidden) this.question.focus(); }
  }
  async pasteContext() {
    const text = this.host.paste();
    if (!text?.trim()) throw new Error("剪贴板没有文字。");
    this.context = makeContext({ text, title: "粘贴材料", kind: "手动材料" });
    this.contextChanged(); this.closeExtras(); this.question.focus();
  }
  clearContext() { this.context = null; this.contextChanged(); this.closeExtras(); this.question.focus(); }
  closeExtras() {
    this.addMenu.hidden = true; this.addButton.setAttribute("aria-expanded", "false");
    this.materialPreview.hidden = true; this.contextButton.setAttribute("aria-expanded", "false");
  }
  openAddMenu(open) {
    this.closeExtras();
    if (open && !this.busy) { this.addMenu.hidden = false; this.addButton.setAttribute("aria-expanded", "true"); this.addMenu.querySelector("button").focus(); }
  }
  openMaterialPreview(open) {
    this.closeExtras();
    if (open && this.context) { this.materialPreview.hidden = false; this.contextButton.setAttribute("aria-expanded", "true"); this.previewClose.focus(); }
  }
  resizeQuestion() {
    this.question.style.height = "auto";
    this.question.style.height = `${Math.min(180, Math.max(48, this.question.scrollHeight))}px`;
    this.question.style.overflowY = this.question.scrollHeight > 180 ? "auto" : "hidden";
  }
  contextChanged() {
    const c = this.context, pdf = c?.type === "pdf";
    this.attachment.hidden = !pdf && !c?.text;
    this.contextIcon.textContent = pdf ? "PDF" : "❞"; this.contextIcon.classList.toggle("gptz-pdf-icon", pdf);
    this.contextLabel.textContent = c?.title || ""; this.contextButton.title = c?.title || "查看论文材料";
    this.contextInfo.textContent = pdf ? `PDF 原文件 · ${this.fileSize(c.size)}` : c?.text ? `${c.kind}${c.page ? ` · p.${c.page}` : ""} · ${c.text.length.toLocaleString()} 字${c.truncated ? " · 已截取" : ""}` : "";
    this.preview.textContent = pdf ? `${c.filename}\n${this.fileSize(c.size)}\n发送原始 PDF，保留页面中的公式与图表。` : c?.text || "";
    if (!pdf && !c?.text) this.closeExtras();
  }
  fileSize(size) { return size >= 1000000 ? `${(size / 1000000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1000))} KB`; }
  prompt() {
    return buildPrompt(this.question.value, this.context);
  }
  async send() {
    if (this.busy) return;
    const profile = this.host.taskProfile("chat"), identity = this.host.profileIdentity(profile);
    if (!profile.model) { this.openModelSettings(); throw new Error("请先为此配置选择模型。"); }
    if (this.messages.length >= 40) throw new Error("当前对话已达到 20 轮，请保存需要的回答后开始新对话。");
    const ctx = this.context ? { ...this.context } : null, question = this.question.value;
    const userMessage = buildUserMessage(question, ctx), requestMessages = [...this.messages, userMessage];
    assertPDFSupport(profile, requestMessages);
    this.cancelRequested = false; this.setBusy(true);
    this.empty?.remove(); this.addMessage("你", question, ctx);
    const { article, body } = this.addMessage(providerName(profile.provider), "正在生成…");
    const actions = this.row(); article.append(actions);
    const record = { answer: "", question, context: ctx || this.chatContext, material: ctx, mode: profileSummary(profile), role: providerName(profile.provider), date: new Date().toISOString(), partial: true };
    this.question.value = ""; this.context = null; this.contextChanged(); this.resizeQuestion();
    this.scrollToBottom(); this.status("正在连接…");
    let tier, renderTimer;
    const paint = () => {
      renderTimer = null;
      if (this.disposed || !body.isConnected) return;
      const follow = this.followOutput && this.transcript.scrollTop >= this.lastScrollTop - 1; this.followOutput = follow;
      this.renderMarkdown(body, record.answer);
      if (follow) this.scrollToBottom();
    };
    try {
      record.source = record.context?.itemID ? record.context : await this.host.currentSource();
      if (this.cancelRequested) throw Object.assign(new Error("已停止生成。"), { name: "AbortError" });
      if (requestMessages.some(m => m.pdf)) this.status("正在准备 PDF 原文件…");
      const messages = await this.host.prepareMessages(requestMessages, { isCancelled: () => this.cancelRequested || this.disposed || identity !== this.host.profileIdentity(this.host.taskProfile("chat")) });
      if (this.disposed) return;
      if (this.cancelRequested) throw Object.assign(new Error("已停止生成。"), { name: "AbortError" });
      const key = await this.host.credential(profile.provider); if (this.disposed) return;
      if (this.cancelRequested) throw Object.assign(new Error("已停止生成。"), { name: "AbortError" });
      if (identity !== this.host.profileIdentity(this.host.taskProfile("chat")) || (profile.provider === "chatgpt" && this.auth.signingOut)) throw new Error("模型配置或账号已改变，请重新发送。");
      this.pending = streamModel({ window: this.window, key, profile, messages,
        onComplete: meta => { tier = meta.tier; }, onText: text => {
          if (this.disposed) return;
          record.answer = text;
          if (renderTimer == null) renderTimer = this.window.setTimeout(paint, 50);
        }
      });
      this.setBusy(true); this.status("正在生成…");
      record.answer = await this.pending.promise;
      if (this.disposed) return;
      if (identity !== this.host.profileIdentity(this.host.taskProfile("chat"))) throw Object.assign(new Error("模型配置已改变，旧回答未加入当前对话。"), { name: "AbortError" });
      record.partial = false; this.messages.push(userMessage, { role: "assistant", content: record.answer });
      if (ctx) this.chatContext = ctx;
      const speed = ["openai", "chatgpt"].includes(profile.provider) ? ` · ${tierLabel(tier, profile.options.fast)}` : "";
      record.mode += speed; this.turns.push(record); this.status(`完成 · ${profile.name}${speed}`);
    } catch (error) {
      if (body && !record.answer) body.textContent = error.message;
      if (!this.disposed && !this.question.value && !this.context) {
        this.question.value = question; this.context = ctx; this.contextChanged(); this.resizeQuestion();
      }
      this.status(error.message, error.name !== "AbortError");
    } finally {
      this.window.clearTimeout(renderTimer);
      const follow = this.followOutput && this.transcript.scrollTop >= this.lastScrollTop - 1; this.pending = null; this.setBusy(false);
      if (!this.disposed && record?.answer) {
        this.renderMarkdown(body, record.answer);
        if (record.partial) article.append(this.el("p", { class: "gptz-muted" }, "未完成回答，未加入后续对话。"));
        this.answerActions(actions, record);
      }
      if (!this.disposed && body.isConnected && follow) this.scrollToBottom();
      if (!this.disposed && !this.root.hidden) this.question.focus();
      if (!record.partial && !this.disposed) {
        try { await this.persistConversation(); }
        catch (error) { this.status(`回答已完成，但历史保存失败：${error.message}`, true); }
      }
    }
  }
  nearBottom() { return this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 80; }
  scrollToBottom() {
    this.followOutput = true; this.transcript.scrollTop = this.transcript.scrollHeight;
    this.lastScrollTop = this.transcript.scrollTop;
  }
  addMessage(role, text, context = null) {
    const article = this.el("article", { class: `gptz-message ${role === "你" ? "gptz-user" : ""}` });
    const body = this.el("div", { class: "gptz-answer" }); this.renderMarkdown(body, text);
    article.append(this.el("strong", { class: "gptz-role" }, role));
    if (context?.type === "pdf") {
      const material = this.el("div", { class: "gptz-sent-material gptz-sent-pdf" });
      material.append(this.el("strong", {}, `PDF · ${context.filename}`), this.el("p", { class: "gptz-muted" }, `${context.title} · ${this.fileSize(context.size)} · 原文件`));
      article.append(material);
    } else if (context?.text) {
      const material = this.el("details", { class: "gptz-sent-material" });
      const summary = this.el("summary", { title: context.title }, `论文选文 · ${context.title}${context.page ? ` · p.${context.page}` : ""} · ${context.text.length.toLocaleString()} 字`);
      material.append(summary, this.el("p", { class: "gptz-muted" }, `${context.kind}${context.truncated ? " · 已截取，非完整材料" : ""}`), this.el("div", { class: "gptz-source-text" }, context.text));
      article.append(material);
    }
    article.append(body); this.transcript.append(article); return { article, body };
  }
  renderMarkdown(node, text) {
    try {
      renderRichText(node, text, this.purify, url => this.host.openExternal(url));
      node.style.removeProperty("white-space");
    } catch {
      // Rendering must not discard received text or block completion and saving.
      node.textContent = text; node.style.whiteSpace = "pre-wrap";
    }
  }
  setBusy(busy) {
    if (this.disposed) return; this.busy = busy;
    if (busy) this.closeExtras();
    this.controls.forEach(c => { c.disabled = busy; }); this.stopButton.hidden = !busy; this.sendButton.hidden = busy;
    this.refreshProfiles();
  }
  resetChat(force = false) {
    if (this.busy && !force) return;
    this.turns = []; this.historyID = null; this.historyCreatedAt = null;
    this.messages = []; this.chatContext = null; this.transcript.replaceChildren();
    this.empty = this.el("div", { class: "gptz-empty" });
    this.empty.append(this.el("strong", {}, "想聊聊这篇论文？")); this.transcript.append(this.empty);
  }
  answerActions(actions, record) {
    actions.append(this.button("复制", () => { this.host.copy(record.answer); this.status("已复制回答。"); }, {}, false), this.button("导出笔记", () => this.saveRecord(record), {}, false));
  }
  buildHistory() {
    this.historyView = this.el("section", { class: "gptz-history", "aria-label": "历史对话列表" }); this.historyView.hidden = true;
    this.saveHistoryButton = this.button("保存当前对话", async () => { await this.persistConversation(); await this.renderHistory(); this.status("对话已保存。"); });
    this.historyList = this.el("div", { class: "gptz-history-list" });
    this.historyView.append(this.row(this.el("strong", {}, "历史对话"), this.button("返回", () => this.openHistory(false))), this.saveHistoryButton, this.historyList);
  }
  async openHistory(open = true) {
    if (this.busy) return;
    this.closeExtras(); if (!this.models.root.hidden) this.models.close();
    this.historyView.hidden = !open; this.chatView.hidden = open; this.historyButton.setAttribute("aria-expanded", String(open));
    if (open) { this.settings.hidden = true; this.settingsOpen = false; this.settingsButton.setAttribute("aria-expanded", "false"); await this.renderHistory(); }
  }
  async renderHistory() {
    this.setBusy(true);
    try {
      const entries = await this.host.history().list(); if (this.disposed) return;
      this.historyList.replaceChildren();
      for (const entry of entries) {
        const row = this.row(); row.classList.add("gptz-history-item"); row.dataset.conversationId = entry.id;
        const open = this.button("", () => this.restoreConversation(entry.id), { class: "gptz-history-open", title: entry.title }, false);
        open.append(this.el("span", { class: "gptz-history-title" }, entry.title), this.el("small", {}, new Date(entry.updatedAt).toLocaleString()));
        const remove = this.button("删除", () => { remove.hidden = true; confirm.hidden = false; cancel.hidden = false; }, {}, false);
        const confirm = this.button("确认删除", () => this.deleteConversation(entry.id), { "aria-label": `确认删除 ${entry.title}` }, false);
        const cancel = this.button("取消", () => { remove.hidden = false; confirm.hidden = true; cancel.hidden = true; }, {}, false);
        confirm.hidden = true; cancel.hidden = true; row.append(open, remove, confirm, cancel); this.historyList.append(row);
      }
      if (!entries.length) this.historyList.append(this.el("p", { class: "gptz-muted" }, "完整回答会自动保存到这里。"));
    } finally { this.setBusy(false); this.saveHistoryButton.disabled = !this.turns.length; }
  }
  async persistConversation() {
    if (!this.turns.length) throw new Error("请先完成一轮对话。");
    this.historyID ||= this.window.crypto.randomUUID(); this.historyCreatedAt ||= new Date().toISOString();
    return this.host.history().save({ id: this.historyID, createdAt: this.historyCreatedAt, updatedAt: new Date().toISOString(), turns: this.turns });
  }
  async restoreConversation(id) {
    if (this.busy) return;
    if (this.question.value.trim() || this.context) throw new Error("请先发送或清空当前问题和材料，再打开历史对话。");
    this.setBusy(true);
    try {
      const entry = await this.host.history().get(id); if (this.disposed) return;
      this.resetChat(true); this.empty.remove(); this.historyID = entry.id; this.historyCreatedAt = entry.createdAt;
      let context = null;
      for (const saved of entry.turns) {
        if (saved.material) context = saved.material;
        const record = { ...saved, context, partial: false }; this.turns.push(record);
        this.messages.push(buildUserMessage(saved.question, saved.material), { role: "assistant", content: saved.answer });
        this.addMessage("你", saved.question, saved.material);
        const { article } = this.addMessage(saved.role, saved.answer), actions = this.row(); article.append(actions); this.answerActions(actions, record);
      }
      this.chatContext = context; this.contextChanged(); this.historyView.hidden = true; this.chatView.hidden = false;
      this.historyButton.setAttribute("aria-expanded", "false"); this.scrollToBottom(); this.question.focus();
    } finally { this.setBusy(false); }
  }
  async deleteConversation(id) {
    if (this.busy) return;
    this.setBusy(true);
    try { await this.host.history().delete(id); if (this.historyID === id) this.resetChat(true); }
    finally { this.setBusy(false); }
    await this.renderHistory(); this.status("历史对话已删除。");
  }
  buildNoteEditor() {
    this.noteView = this.el("section", { class: "gptz-note-export", "aria-label": "导出 Markdown 笔记" }); this.noteView.hidden = true;
    this.noteEditor = this.el("textarea", { class: "gptz-note-editor", "aria-label": "Markdown 笔记", spellcheck: "false" }); this.controls.push(this.noteEditor);
    this.noteView.append(this.row(this.el("strong", {}, "导出笔记"), this.button("取消", () => this.closeNoteEditor())),
      this.noteEditor, this.row(this.button("插入图片", () => this.insertNoteImage()), this.button("导出为附件", () => this.exportRecord(), { class: "gptz-primary" })),
      this.el("p", { class: "gptz-muted" }, "Markdown 与图片一起保存在来源文献的附件中。"));
  }
  async saveRecord(record) {
    if (this.busy) throw new Error("请先等待当前操作完成，再导出笔记。");
    this.setBusy(true);
    try {
      this.noteRecord = { ...record, source: record.source || await this.host.currentSource() };
      this.noteImages = []; this.noteEditor.value = noteMarkdown(this.noteRecord);
      this.noteView.hidden = false; this.chatView.hidden = true; this.noteEditor.focus();
    } finally { this.setBusy(false); }
  }
  closeNoteEditor() { this.noteView.hidden = true; this.chatView.hidden = false; this.noteRecord = null; this.noteImages = []; this.refreshProfiles(); this.question.focus(); }
  async insertNoteImage() {
    if (this.busy) return;
    const start = this.noteEditor.selectionStart, end = this.noteEditor.selectionEnd; this.setBusy(true);
    try {
      const image = await this.host.pickImage(); if (!image || this.disposed) return;
      this.noteImages.push(image);
      const label = image.label.replace(/[\\[\]\r\n]/g, " ");
      this.noteEditor.setRangeText(`\n\n![${label}](assets/${image.name})\n\n`, start, end, "end");
    } finally { this.setBusy(false); this.noteEditor.focus(); }
  }
  async exportRecord() {
    if (this.busy || !this.noteRecord) return;
    this.setBusy(true);
    try { const id = await this.host.saveNote(this.noteRecord, this.noteEditor.value, this.noteImages); this.closeNoteEditor(); this.status("Markdown 笔记已导出为来源文献的附件。"); return id; }
    finally { this.setBusy(false); }
  }
  destroy() {
    this.disposed = true; this.unsubscribe?.(); this.pending?.cancel(); this.models.destroy();
    this.window.clearTimeout(this.statusTimer); this.doc.removeEventListener("pointerdown", this.outsideClick);
    const width = Math.round(this.root.getBoundingClientRect().width); if (width >= 360) this.host.setPref("width", width);
    this.nodes.forEach(n => n.remove()); this.messages = []; this.context = null;
  }
}
