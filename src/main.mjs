import { Panel } from "./panel.mjs";
import { ZoteroHost } from "./zotero.mjs";
import { SelectionTranslator } from "./selection.mjs";
import { ChatGPTAuth } from "./auth.mjs";

let data;
const windows = new Map();
let selectionHandler;
let translator;
let auth;

export async function start(info) {
  data = info;
  await Zotero.uiReadyPromise;
  auth = new ChatGPTAuth(new ZoteroHost(Zotero.getMainWindow()));
  new ZoteroHost(Zotero.getMainWindow(), auth).profiles();
  for (const window of Zotero.getMainWindows()) attach(window);
  translator = new SelectionTranslator({
    host: new ZoteroHost(Zotero.getMainWindow(), auth),
    openChat: async selection => {
      const panel = windows.get(Zotero.getMainWindow())?.getPanel();
      if (!panel) return;
      panel.show(); await panel.loadContext("selection", selection); panel.question.focus();
    },
    openSettings: () => {
      const panel = windows.get(Zotero.getMainWindow())?.getPanel();
      if (panel) { panel.show(); panel.openModelSettings("translation"); }
    }
  });
  selectionHandler = event => {
    // Reader dispatch is shared with other plugins. Never let our errors escape it.
    try {
      translator.render(event);
    } catch (error) { Zotero.logError(new Error(`LLM for Zotero selection: ${error.message}`)); }
  };
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", selectionHandler, data.id);
}

export function attach(window) {
  if (!data || windows.has(window) || !window.ZoteroPane) return;
  const nodes = []; let panel;
  const getPanel = () => panel ||= new Panel(window, new ZoteroHost(window, auth), data.rootURI, data.version);
  const open = () => {
    try { getPanel().toggle(); } catch (e) { window.alert(`LLM for Zotero 无法打开：${e.message}`); }
  };
  const doc = window.document;
  const toolbar = doc.getElementById("zotero-tabs-toolbar");
  const button = doc.createXULElement("toolbarbutton");
  button.id = "gptz-toolbar-button"; button.setAttribute("label", "LLM for Zotero");
  button.setAttribute("aria-label", "LLM for Zotero");
  button.setAttribute("tooltiptext", "LLM for Zotero · Ctrl+Shift+G");
  button.setAttribute("image", data.rootURI + "icons/llm.svg");
  button.setAttribute("style", "width:32px;min-width:32px;max-width:32px;min-height:28px;padding:4px;appearance:none;justify-content:center;align-items:center;");
  const toolbarStyle = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  toolbarStyle.textContent = "#gptz-toolbar-button .toolbarbutton-text{display:none!important}#gptz-toolbar-button .toolbarbutton-icon{display:block!important;width:20px!important;height:20px!important;margin:0!important;padding:0!important}";
  doc.documentElement.append(toolbarStyle); nodes.push(toolbarStyle);
  button.addEventListener("command", open); toolbar?.append(button); nodes.push(button);
  const menu = doc.createXULElement("menuitem"); menu.id = "gptz-menu";
  menu.setAttribute("label", "LLM for Zotero"); menu.addEventListener("command", open);
  doc.getElementById("menu_ToolsPopup")?.append(menu); nodes.push(menu);
  const key = e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "g" && !e.isComposing) { e.preventDefault(); open(); }
  };
  window.addEventListener("keydown", key);
  windows.set(window, { getPanel, destroy() { panel?.destroy(); nodes.forEach(n => n.remove()); window.removeEventListener("keydown", key); } });
}
export function detach(window) { windows.get(window)?.destroy(); windows.delete(window); }
export function stop() {
  translator?.destroy(); translator = null;
  if (selectionHandler) Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", selectionHandler);
  for (const window of [...windows.keys()]) detach(window);
  auth?.destroy(); auth = null;
  data = null;
}
