import { buildPrompt, makeContext, tierLabel, CONTEXT_LIMIT } from "./core.mjs";
import { TRANSLATION_INSTRUCTIONS } from "./instructions.mjs";
import { streamModel } from "./providers.mjs";
import { providerName, profileSummary } from "./profiles.mjs";

export class SelectionTranslator {
  constructor({ host, openChat, openSettings, request = streamModel, delay = 250, detachDelay = 50 }) {
    this.host = host; this.openChat = openChat; this.openSettings = openSettings; this.request = request; this.delay = delay; this.detachDelay = detachDelay;
    this.active = new Map(); this.cache = new Map();
    this.identity = this.currentIdentity();
    this.unsubscribe = host.auth?.subscribe(() => {
      const identity = this.currentIdentity();
      const profile = this.host.taskProfile("translation");
      if (identity !== this.identity || (profile.provider === "chatgpt" && (host.auth.signingOut || !host.auth.current()?.access_token))) {
        for (const state of [...this.active.values()]) {
          state.stop(); state.root.querySelector('[role="status"]').textContent = "翻译配置或账号已改变，请重新选文。";
        }
        this.cache.clear(); this.identity = identity;
      }
    });
  }
  currentIdentity() { return this.host.profileIdentity(this.host.taskProfile("translation")); }
  render(event) {
    const text = event.params?.annotation?.text?.trim();
    if (!text) return;
    const { reader, doc } = event;
    this.active.get(reader)?.stop();
    const selection = { text, itemID: reader.itemID, page: event.params.annotation.pageLabel || "" };
    const win = this.host.window;
    const root = doc.createElement("section"); root.className = "gptz-selection";
    root.style.cssText = "padding:8px 0;width:100%;box-sizing:border-box;border-top:1px solid #8884;font:13px/1.6 system-ui;color:inherit;";
    const style = doc.createElement("style");
    style.textContent = ".selection-popup:has(.gptz-selection){width:360px;max-width:calc(100% - 24px)}.gptz-selection [hidden]{display:none!important}.gptz-selection button{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:auto;max-height:none;min-height:28px;line-height:1.3;margin:0;box-sizing:border-box}";
    root.append(style);
    const label = doc.createElement("span"); label.textContent = "LLM 翻译";
    label.style.cssText = "font-size:11px;opacity:.75;display:block;overflow-wrap:anywhere";
    const body = doc.createElement("div"); body.setAttribute("role", "status");
    body.style.cssText = "white-space:pre-wrap;max-height:220px;overflow:auto;overflow-wrap:anywhere;margin-top:6px;user-select:text";
    const button = (text, fn) => {
      const node = doc.createElement("button"); node.type = "button"; node.textContent = text;
      node.style.cssText = "font:inherit;padding:4px 8px;border:1px solid #9aa7b188;border-radius:5px;background:transparent;color:inherit;cursor:pointer";
      node.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(fn).catch(error => { body.textContent = error.message; }); });
      return node;
    };
    let pending, timer, detachTimer, stopped = false, attached = false, running = false, translation = "";
    const stop = () => {
      if (stopped) return;
      stopped = true; win.clearTimeout(timer); win.clearTimeout(detachTimer); pending?.cancel(); observer.disconnect();
      doc.defaultView.removeEventListener("pagehide", stop);
      if (this.active.get(reader)?.root === root) this.active.delete(reader);
    };
    const observer = new win.MutationObserver(() => {
      if (root.isConnected) { attached = true; win.clearTimeout(detachTimer); detachTimer = null; }
      else if (attached && !detachTimer) {
        // Reader layout can temporarily reparent a popup. Cancel only if it stays closed.
        detachTimer = win.setTimeout(() => { detachTimer = null; if (!root.isConnected) stop(); }, this.detachDelay);
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    doc.defaultView.addEventListener("pagehide", stop); this.active.set(reader, { root, stop });
    const run = async () => {
      if (stopped || !root.isConnected || running) return;
      running = true; retry.hidden = true; connect.hidden = true; copy.hidden = true; translation = "";
      body.textContent = "正在翻译…";
      const context = makeContext({ text, title: "PDF 选文", kind: "选文", page: selection.page, limit: CONTEXT_LIMIT });
      const show = value => {
        if (!stopped) { translation = value; body.textContent = value + (context.truncated ? "\n（选文超过 24,000 字符，仅翻译前段。）" : ""); }
      };
      try {
        const profile = this.host.taskProfile("translation"), identity = this.host.profileIdentity(profile);
        label.textContent = `${providerName(profile.provider)} · ${profile.name}`; label.title = profileSummary(profile);
        if (!profile.model) throw new Error("请在模型配置中选择翻译模型。");
        const cacheKey = JSON.stringify([identity, context.text]);
        if (this.cache.has(cacheKey)) {
          const saved = this.cache.get(cacheKey); show(saved.text); label.textContent += " · 已缓存"; copy.hidden = false; return;
        }
        const key = await this.host.credential(profile.provider);
        if (stopped || this.currentIdentity() !== identity) return;
        let tier;
        pending = this.request({ window: win, key, profile, instructions: TRANSLATION_INSTRUCTIONS,
          messages: [{ role: "user", content: buildPrompt("请翻译以下选文。", context) }], onText: show, onComplete: meta => { tier = meta.tier; }
        });
        const answer = await pending.promise;
        if (stopped || this.currentIdentity() !== identity) return;
        show(answer);
        if (["openai", "chatgpt"].includes(profile.provider)) label.textContent += ` · ${tierLabel(tier, profile.options.fast)}`;
        copy.hidden = false; this.cache.set(cacheKey, { text: answer });
        if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
      } catch (error) {
        if (!stopped) {
          body.textContent = translation ? `${translation}\n\n${error.message}（译文未完成，请重试。）` : error.message;
          connect.hidden = false; retry.hidden = false;
        }
      } finally { pending = null; running = false; }
    };
    const footer = doc.createElement("div"); footer.style.cssText = "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap";
    const retry = button("重试翻译", run), connect = button("模型配置", () => this.openSettings()), copy = button("复制译文", () => this.host.copy(translation));
    connect.hidden = true; copy.hidden = true;
    footer.append(button("加入对话", () => this.openChat(selection)), copy, retry, connect); root.append(label, body, footer);
    if (this.host.getPref("autoTranslate", true)) {
      retry.hidden = true; body.textContent = "准备翻译…";
      timer = win.setTimeout(() => { run().catch(error => { if (!stopped) body.textContent = error.message; }); }, this.delay);
    } else body.textContent = "自动翻译已关闭。";
    event.append(root);
  }
  destroy() {
    this.unsubscribe?.(); for (const state of [...this.active.values()]) { state.stop(); state.root.remove(); } this.cache.clear();
  }
}
