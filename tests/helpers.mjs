import { JSDOM } from "jsdom";
import { ZoteroHost } from "../src/zotero.mjs";
import { Panel } from "../src/panel.mjs";
import { makeContext } from "../src/core.mjs";
import { ConversationStore } from "../src/history.mjs";

export const profiles = () => [
  { id: "deepseek", name: "DeepSeek 快译", provider: "deepseek", model: "deepseek-flash", options: { thinking: false, effort: "high" } },
  { id: "gemini", name: "Gemini 精读", provider: "gemini", model: "gemini-3.8-flash", options: { thinkingLevel: "high" } },
  { id: "chatgpt", name: "ChatGPT", provider: "chatgpt", model: "gpt-test", options: { effort: "medium", fast: false } },
  { id: "openai", name: "OpenAI API", provider: "openai", model: "gpt-api", options: { effort: "low", fast: true } }
];

export const flush = () => new Promise(resolve => setImmediate(resolve));
export const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
export function runtime(t, { panel = true, migration = false, keys = true } = {}) {
  const dom = new JSDOM('<html><body><div id="browser"></div></body></html>', { url: "https://local.test" });
  dom.window.document.createXULElement = name => dom.window.document.createElement(name);
  const prefs = new Map(migration ? [] : [["modelProfiles", JSON.stringify(profiles())], ["translationProfileID", "deepseek"], ["chatProfileID", "gemini"]]);
  const secrets = new Map(keys ? [["deepseek", "fake-deepseek"], ["gemini", "fake-gemini"], ["openai", "fake-openai"]] : []);
  const listeners = new Set(), requests = [];
  let account = { client_id: "test-account", access_token: "fake-account-token", email: "reader@example.test", connected: true };
  const auth = {
    current: () => account, accounts: () => [account], subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, changed: () => listeners.forEach(fn => fn()),
    accessToken: async () => { if (!account.access_token) throw new Error("账号已退出"); return account.access_token; },
    signOut: async () => { account = { ...account, access_token: undefined, connected: false }; auth.changed(); return true; }
  };
  const host = new ZoteroHost(dom.window, auth);
  let historyText = null;
  const history = new ConversationStore({ read: async () => historyText, write: async text => { historyText = text; } });
  Object.assign(host, {
    getPref: (name, fallback) => prefs.get(name) ?? fallback,
    setPref: (name, value) => { prefs.set(name, value); if (["modelProfiles", "translationProfileID", "chatProfileID", "keyRevision", "deepseekKeyRevision", "geminiKeyRevision"].includes(name)) auth.changed(); },
    getKey: (provider = "openai") => secrets.get(provider === "api" ? "openai" : provider) || "",
    setKey: async (value, provider = "openai") => { const name = provider === "api" ? "openai" : provider; secrets.set(name, value); const revision = name === "openai" ? "keyRevision" : `${name}KeyRevision`; host.setPref(revision, host.getPref(revision, 0) + 1); },
    context: async () => makeContext({ title: "Paper", kind: "摘要", text: "source text", itemID: 12 }),
    copy() {}, paste: () => "material", openExternal() {}, saveNote: async () => 42,
    currentSource: async () => ({ itemID: 12, title: "Paper", uri: "zotero://select/library/items/PAPER" }),
    history: () => history, pickImage: async () => null
  });
  dom.window.XMLHttpRequest = class {
    constructor(options) { this.options = options; this.headers = {}; this.status = 200; this.responseText = ""; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) { this.body = body; requests.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    push(event) { this.responseText += `data: ${JSON.stringify(event)}\n\n`; this.onprogress?.(); }
    load(body) { this.responseText = JSON.stringify(body); this.onload(); }
  };
  const ui = panel ? new Panel(dom.window, host, "https://local.test/") : null;
  t?.after(() => { ui?.destroy(); dom.window.close(); });
  return { dom, host, auth, prefs, secrets, requests, panel: ui };
}
