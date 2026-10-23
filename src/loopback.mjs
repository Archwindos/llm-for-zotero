// Use Zotero's bundled HTTP implementation; bind only to IPv4 loopback.
export function listenLoopback(_window, handle) {
  const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
  const server = new HttpServer();
  server.start(-1);
  const port = server.identity.primaryPort, origin = `http://127.0.0.1:${port}`;
  let closed = false;
  server.registerPathHandler("/auth/callback", (request, response) => {
    response.setHeader("Cache-Control", "no-store", false);
    response.setHeader("Referrer-Policy", "no-referrer", false);
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'", false);
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    if (closed || request.method !== "GET" || request.getHeader("Host") !== `127.0.0.1:${port}` || request.queryString.length > 16000) {
      response.setStatusLine("1.1", 400, "Bad Request"); response.write("Invalid callback."); return;
    }
    response.processAsync();
    const finish = (success) => {
      response.setStatusLine("1.1", success ? 200 : 400, success ? "OK" : "Bad Request");
      // Never reflect the callback's code or other parameters into the page.
      response.write(`<!doctype html><meta charset="utf-8"><title>LLM for Zotero</title><body style="font:18px system-ui;padding:60px;max-width:650px;margin:auto"><h1>LLM for Zotero</h1><p>${success ? "Connected. Your ChatGPT account is ready in Zotero." : "Sign-in did not complete. See Zotero for details."}</p><p>You can return to Zotero now.</p>`);
      response.finish();
    };
    Promise.resolve().then(() => handle(`${origin}/auth/callback?${request.queryString}`)).then(() => finish(true), () => finish(false));
  });
  return { redirectURI: origin + "/auth/callback", close() { if (!closed) { closed = true; server.stop().catch(() => {}); } } };
}
