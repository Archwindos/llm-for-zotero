import { MODEL_DEFAULT, makeContext, noteMarkdown } from "./core.mjs";
import { ConversationStore } from "./history.mjs";
import { DEEPSEEK_MODEL } from "./deepseek.mjs";
import { migrateProfiles, normalizeProfile } from "./profiles.mjs";
import { PDF_BYTES_LIMIT, isPDF, pdfBase64, pdfCancelled } from "./pdf.mjs";

const PREF = "extensions.gpt-for-zotero.";
const LOGIN_ORIGIN = "https://api.openai.com";
const LOGIN_REALM = "gpt-for-zotero API key";
const ACCOUNT_REALM = "gpt-for-zotero ChatGPT accounts";
const DEEPSEEK_REALM = "gpt-for-zotero DeepSeek translation key";
const KEY_STORES = {
  api: [LOGIN_ORIGIN, LOGIN_REALM, "keyRevision"],
  openai: [LOGIN_ORIGIN, LOGIN_REALM, "keyRevision"],
  deepseek: ["https://api.deepseek.com", DEEPSEEK_REALM, "deepseekKeyRevision"],
  gemini: ["https://generativelanguage.googleapis.com", "llm-for-zotero Gemini API key", "geminiKeyRevision"]
};
let conversations;

export class ZoteroHost {
  constructor(window, auth) { this.window = window; this.auth = auth; }
  getPref(name, fallback) { return Zotero.Prefs.get(PREF + name, true) ?? fallback; }
  setPref(name, value) {
    Zotero.Prefs.set(PREF + name, value, true);
    if (["mode", "keyRevision", "translationProvider", "deepseekKeyRevision", "geminiKeyRevision", "modelProfiles", "translationProfileID", "chatProfileID"].includes(name)) this.auth?.changed();
  }
  get model() { return this.getPref("model", MODEL_DEFAULT); }
  getKey(provider = "api") {
    if (!KEY_STORES[provider]) throw new Error("不支持此厂家的密钥类型。");
    const [origin, realm] = KEY_STORES[provider];
    return Services.logins.findLogins(origin, null, realm)[0]?.password || "";
  }
  async setKey(key, provider = "api") {
    if (!KEY_STORES[provider]) throw new Error("不支持此厂家的密钥类型。");
    const [origin, realm, revision] = KEY_STORES[provider];
    const existing = Services.logins.findLogins(origin, null, realm);
    const value = key.trim();
    if (!value) { for (const login of existing) Services.logins.removeLogin(login); }
    else {
      const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      login.init(origin, null, realm, "gpt-for-zotero", value, "", "");
      if (existing.length) Services.logins.modifyLogin(existing[0], login);
      else await Services.logins.addLoginAsync(login);
    }
    this.setPref(revision, this.getPref(revision, 0) + 1);
  }
  getAccounts() {
    const value = Services.logins.findLogins("https://auth.openai.com", null, ACCOUNT_REALM)[0]?.password;
    return value ? JSON.parse(value) : [];
  }
  async setAccounts(accounts) {
    const existing = Services.logins.findLogins("https://auth.openai.com", null, ACCOUNT_REALM);
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("https://auth.openai.com", null, ACCOUNT_REALM, "gpt-for-zotero", JSON.stringify(accounts), "", "");
    if (existing.length) Services.logins.modifyLogin(existing[0], login);
    else await Services.logins.addLoginAsync(login);
  }
  get mode() { return this.getPref("mode", "chatgpt") === "api" ? "api" : "chatgpt"; }
  get translationMode() { return this.getPref("translationProvider", "chat") === "deepseek" ? "deepseek" : this.mode; }
  modelFor(mode = this.mode, translation = false) {
    if (mode === "deepseek") return this.getPref("deepseekTranslationModel", DEEPSEEK_MODEL);
    if (mode === "api") return this.getPref(translation ? "translationModel" : "model", MODEL_DEFAULT) || this.getPref("model", MODEL_DEFAULT);
    return this.getPref(translation ? "chatgptTranslationModel" : "chatgptModel", "") || this.getPref("chatgptModel", "");
  }
  async credential(mode = this.mode) {
    if (!["api", "openai", "chatgpt", "deepseek", "gemini"].includes(mode)) throw new Error("不支持此模型厂家。");
    if (mode === "deepseek" || mode === "gemini") {
      const key = this.getKey(mode); if (!key) throw new Error(`请在模型配置中保存 ${mode === "gemini" ? "Gemini" : "DeepSeek"} API Key。`); return key;
    }
    if (mode === "chatgpt") return this.auth.accessToken();
    const key = this.getKey(); if (!key) throw new Error("请先填写 OpenAI API Key，或切换到 ChatGPT 账号并登录。"); return key;
  }
  cacheIdentity(mode = this.mode) {
    if (mode === "chatgpt") return `chatgpt:${this.auth?.current()?.client_id || ""}`;
    const store = KEY_STORES[mode];
    if (!store) throw new Error("不支持此模型厂家。");
    return `${mode === "api" ? "openai" : mode}:${this.getPref(store[2], 0)}`;
  }
  profiles() { return migrateProfiles(this); }
  taskProfile(task) {
    const profiles = this.profiles(), id = this.getPref(task === "translation" ? "translationProfileID" : "chatProfileID", "");
    const profile = profiles.find(p => p.id === id);
    if (!profile) throw new Error("请在设置中为此功能选择一个模型配置。");
    return profile;
  }
  profileIdentity(profile) { return JSON.stringify([this.cacheIdentity(profile.provider), normalizeProfile(profile)]); }
  saveProfile(value) {
    const profile = normalizeProfile(value), profiles = this.profiles();
    const index = profiles.findIndex(p => p.id === profile.id);
    if (index < 0) profiles.push(profile); else profiles[index] = profile;
    this.setPref("modelProfiles", JSON.stringify(profiles)); return profile;
  }
  deleteProfile(id) {
    const profiles = this.profiles().filter(p => p.id !== id);
    if (!profiles.length) throw new Error("请至少保留一个模型配置。");
    if (["translationProfileID", "chatProfileID"].some(key => this.getPref(key, "") === id)) throw new Error("此配置正在使用，请先给翻译和问答选择其他配置。");
    this.setPref("modelProfiles", JSON.stringify(profiles));
  }
  copy(text) { Zotero.Utilities.Internal.copyTextToClipboard(text); }
  paste() { return Zotero.Utilities.Internal.getClipboard("text/unicode"); }
  openExternal(url) { if (/^https:\/\//.test(url)) Zotero.launchURL(url); }
  history() {
    if (!conversations) {
      const path = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "llm-for-zotero-history.json");
      conversations = new ConversationStore({ read: async () => await IOUtils.exists(path) ? IOUtils.readUTF8(path) : null,
        write: text => IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp", flush: true }) });
    }
    return conversations;
  }
  async currentSource() { try { return this.source((await this.selectedItem()).item); } catch { return null; } }
  async pickImage() {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker(); picker.init(this.window, "插入笔记图片", picker.modeOpen);
    picker.appendFilter("图片", "*.png; *.jpg; *.jpeg; *.gif; *.webp; *.bmp");
    if (await picker.show() !== picker.returnOK) return null;
    const extension = picker.file.match(/\.(png|jpe?g|gif|webp|bmp)$/i)?.[1].toLowerCase();
    if (!extension) throw new Error("请选择 PNG、JPEG、GIF、WebP 或 BMP 图片。");
    return { path: picker.file, name: `image-${this.window.crypto.randomUUID()}.${extension}`, label: PathUtils.filename(picker.file) };
  }

  async selectedItem(readerItemID) {
    let id = readerItemID;
    if (!id) id = Zotero.Reader.getByTabID(this.window.Zotero_Tabs?.selectedID)?.itemID;
    let item = id ? await Zotero.Items.getAsync(id) : this.window.ZoteroPane?.getSelectedItems()?.[0];
    if (!item || item.deleted) throw new Error("请先选择一篇文献或打开 PDF。");
    const attachment = item.isAttachment() ? item : null;
    if (item.parentID) item = await Zotero.Items.getAsync(item.parentID);
    if (!item || item.deleted) throw new Error("关联文献已不存在。");
    return { item, attachment };
  }

  source(item) {
    const library = Zotero.Libraries.get(item.libraryID);
    const prefix = library.libraryType === "group" ? `groups/${library.groupID}` : "library";
    return { itemID: item.id, libraryID: item.libraryID, itemKey: item.key, title: item.getField("title") || "未命名文献", uri: `zotero://select/${prefix}/items/${item.key}` };
  }

  async context(kind, selection) {
    const { item, attachment: selected } = await this.selectedItem(selection?.itemID);
    const source = this.source(item);
    if (kind === "selection") {
      if (!selection?.text) throw new Error("请在 PDF 中选中文字，再点击选文弹窗中的“加入对话”。");
      return makeContext({ ...source, kind: "PDF 选文", text: selection.text, page: selection.page });
    }
    if (kind === "abstract") {
      const abstract = item.getField("abstractNote");
      if (!abstract) throw new Error("这篇文献没有摘要。可以添加 PDF 原文件，或自行粘贴材料。");
      return makeContext({ ...source, kind: "文献摘要", text: abstract });
    }
    let attachment = selected;
    if (!attachment && item.isRegularItem()) attachment = await item.getBestAttachment();
    if (!attachment || attachment.attachmentContentType !== "application/pdf") throw new Error("当前文献没有可读取的 PDF 附件，请在 Zotero 中先打开目标 PDF。");
    const { stat } = await this.pdfFile(attachment);
    return { ...source, type: "pdf", kind: "PDF 原文件", attachmentID: attachment.id, attachmentKey: attachment.key,
      attachmentLibraryID: attachment.libraryID, filename: attachment.attachmentFilename || "paper.pdf", size: stat.size, modifiedTime: stat.lastModified };
  }

  async pdfFile(attachment) {
    if (!attachment || attachment.deleted || !attachment.isAttachment() || attachment.attachmentContentType !== "application/pdf") throw new Error("PDF 附件已删除或不再是 PDF，请重新载入原文件。");
    const path = await attachment.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) throw new Error("PDF 原文件不存在或尚未下载到本机，请在 Zotero 中下载附件后重新载入。");
    let stat, header;
    try { stat = await IOUtils.stat(path); header = await IOUtils.read(path, { maxBytes: 5 }); }
    catch { throw new Error("无法读取 PDF 原文件，请检查本地附件后重新载入。"); }
    if (stat.type !== "regular" || !isPDF(header)) throw new Error("附件内容不是有效的 PDF 原文件，请重新选择 PDF。");
    if (!Number.isSafeInteger(stat.size) || stat.size < 5 || !Number.isFinite(stat.lastModified)) throw new Error("PDF 文件信息异常，请重新载入附件。");
    return { path, stat };
  }

  async prepareMessages(messages, { isCancelled = () => false } = {}) {
    const prepared = [], files = new Map();
    let total = 0;
    for (const message of messages) {
      pdfCancelled(isCancelled);
      const next = { role: message.role, content: message.content };
      if (message.pdf) {
        const ref = message.pdf;
        if (message.role !== "user" || ref.type !== "pdf" || !Number.isInteger(ref.attachmentID) || !ref.attachmentKey || !Number.isInteger(ref.attachmentLibraryID) ||
            !Number.isSafeInteger(ref.size) || !Number.isFinite(ref.modifiedTime)) throw new Error("PDF 来源记录不完整，请重新载入原文件。");
        const attachment = await Zotero.Items.getAsync(ref.attachmentID);
        pdfCancelled(isCancelled);
        if (!attachment || attachment.key !== ref.attachmentKey || attachment.libraryID !== ref.attachmentLibraryID) throw new Error("PDF 附件来源已改变或已删除，请重新载入原文件。");
        const { path, stat } = await this.pdfFile(attachment);
        pdfCancelled(isCancelled);
        if (stat.size !== ref.size || stat.lastModified !== ref.modifiedTime) throw new Error("PDF 原文件已被替换或修改，请重新载入后再发送。");
        const identity = JSON.stringify([attachment.libraryID, attachment.key, attachment.id]);
        if (!files.has(identity)) {
          total += stat.size;
          if (total >= PDF_BYTES_LIMIT) throw new Error("一次请求的 PDF 原文件合计必须小于 50 MB，请减少附件后重试。");
          let bytes, after;
          try { bytes = await IOUtils.read(path, { maxBytes: stat.size + 1 }); after = await IOUtils.stat(path); }
          catch { throw new Error("PDF 读取期间已删除或无法读取，请重新载入原文件。"); }
          pdfCancelled(isCancelled);
          if (bytes.length !== stat.size || after.size !== stat.size || after.lastModified !== stat.lastModified || !isPDF(bytes)) throw new Error("PDF 读取期间发生变化，请重新载入原文件后重试。");
          next.pdf = { filename: attachment.attachmentFilename || ref.filename || "paper.pdf", mimeType: "application/pdf",
            data: await pdfBase64(this.window, bytes, isCancelled), size: stat.size };
          files.set(identity, true);
        }
      }
      prepared.push(next);
    }
    pdfCancelled(isCancelled);
    return prepared;
  }

  async saveNote(record, markdown = noteMarkdown(record), images = []) {
    if (!record.answer?.trim()) throw new Error("没有可保存的回答。");
    if (!markdown.trim()) throw new Error("笔记内容不能为空。");
    const origin = record.context?.itemID ? record.context : record.source;
    const parent = origin?.itemID ? await Zotero.Items.getAsync(origin.itemID) : (await this.selectedItem()).item;
    if (!parent || parent.deleted) throw new Error("来源文献已被删除，无法关联笔记。");
    if (!parent.isRegularItem()) throw new Error("请选择一条文献，将 Markdown 笔记导出为它的附件。");
    const library = Zotero.Libraries.get(parent.libraryID);
    if (!library.editable || library.filesEditable === false) throw new Error("当前文献库或附件存储为只读，无法导出笔记。");
    const used = images.filter(image => markdown.includes(`](assets/${image.name})`));
    if (used.some(image => !/^image-[a-zA-Z0-9-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(image.name))) throw new Error("图片文件名异常。");
    const temp = PathUtils.join(Zotero.getTempDirectory().path, `llm-note-${this.window.crypto.randomUUID()}.md`);
    let attachment;
    try {
      await IOUtils.writeUTF8(temp, markdown);
      // importFromFile owns its transaction; defer notifications until images are ready.
      const notifierQueue = new Zotero.Notifier.Queue();
      attachment = await Zotero.Attachments.importFromFile({ file: temp, parentItemID: parent.id, title: `LLM 阅读笔记 · ${record.question?.trim().slice(0, 60) || parent.getField("title")}`, fileBaseName: "LLM 阅读笔记", contentType: "text/markdown", charset: "utf-8", saveOptions: { notifierQueue } });
      if (used.length) {
        const assets = PathUtils.join(Zotero.Attachments.getStorageDirectory(attachment).path, "assets");
        await IOUtils.makeDirectory(assets, { ignoreExisting: true });
        for (const image of used) await IOUtils.copy(image.path, PathUtils.join(assets, image.name));
      }
      await Zotero.Notifier.commit(notifierQueue);
      return attachment.id;
    } catch (error) {
      if (attachment) await attachment.eraseTx();
      throw error;
    } finally { await IOUtils.remove(temp, { ignoreAbsent: true }); }
  }
}
