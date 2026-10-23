var GPTForZotero;
var crypto, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, structuredClone;

async function startup(data) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const win = Zotero.getMainWindow();
  crypto = win.crypto; TextEncoder = win.TextEncoder; TextDecoder = win.TextDecoder;
  URL = win.URL; URLSearchParams = win.URLSearchParams;
  btoa = win.btoa.bind(win); atob = win.atob.bind(win);
  // Zotero's plugin sandbox omits this Web API required by jose's JWK validation.
  structuredClone = win.structuredClone.bind(win);
  Services.scriptloader.loadSubScript(data.rootURI + "plugin.js?v=" + data.version, this);
  await GPTForZotero.start(data);
}

function onMainWindowLoad({ window }) {
  GPTForZotero?.attach(window);
}

function onMainWindowUnload({ window }) {
  GPTForZotero?.detach(window);
}

function shutdown() {
  GPTForZotero?.stop();
  GPTForZotero = undefined;
}

function install() {}
function uninstall() {}
