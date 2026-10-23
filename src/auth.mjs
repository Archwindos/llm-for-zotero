import { ISSUER, TOKEN, RESOURCE, newAttempt, authorizationURL, consumeCallback, verifyIdentity, tokenRecord } from "./auth-core.mjs";
import { listenLoopback } from "./loopback.mjs";

function request(window, url, form) {
  return new Promise((resolve, reject) => {
    const xhr = new window.XMLHttpRequest({ mozAnon: true });
    xhr.open(form ? "POST" : "GET", url); xhr.timeout = 25000;
    xhr.setRequestHeader("Accept", "application/json");
    if (form) xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.onload = () => {
      if (xhr.status !== 200) { reject(new Error(`ChatGPT 登录服务请求失败（HTTP ${xhr.status}）。请重新登录或稍后重试。`)); return; }
      try { resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {}); }
      catch { reject(new Error("登录服务返回格式异常，请重试。")); }
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error("无法连接 ChatGPT 登录服务，请检查网络后重试。"));
    xhr.send(form ? new URLSearchParams(form).toString() : null);
  });
}

export class ChatGPTAuth {
  constructor(host, { listen = listenLoopback, http = request } = {}) {
    this.host = host; this.window = host.window; this.listen = listen; this.http = http;
    this.listeners = new Set(); this.refreshes = new Map(); this.epochs = new Map(); this.pending = null;
  }
  records() { return this.host.getAccounts(); }
  current() { return this.records().find(a => a.client_id === this.host.getPref("chatgptAccount", "")); }
  accounts() { return this.records().map(a => ({ client_id: a.client_id, email: a.email, connected: !!a.access_token })); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(); } catch {} } }
  async put(record) {
    const records = this.records().filter(a => a.client_id !== record.client_id);
    await this.host.setAccounts([...records, record]);
  }
  select(clientID) { this.host.setPref("chatgptAccount", clientID); this.changed(); }
  async keys() { return this.http(this.window, `${ISSUER}/.well-known/jwks.json`); }
  async signIn(clientID) {
    if (this.pending) throw new Error("登录页面已打开，请完成登录或先取消。");
    const retryClient = this.host.getPref("chatgptPendingClient", "");
    const account = clientID ? this.records().find(a => a.client_id === clientID) : retryClient ? { client_id: retryClient } : undefined;
    if (clientID && !account) throw new Error("找不到所选账号，请重新选择。");
    let hostID = this.host.getPref("chatgptHostID", "");
    if (!hostID) { hostID = `urn:uuid:${this.window.crypto.randomUUID()}`; this.host.setPref("chatgptHostID", hostID); }
    let resolve, reject, listener, timer;
    const done = new Promise((a, b) => { resolve = a; reject = b; });
    // Attach a handler before launching the browser, even if initialization fails.
    done.catch(() => {});
    const pending = { cancelled: false, cancel: () => {
      pending.cancelled = true; listener?.close(); reject(new Error("登录已取消。"));
    } };
    this.pending = pending; this.changed();
    try {
      let attempt, handling = false;
      listener = this.listen(this.window, async url => {
        if (!attempt || pending.cancelled || handling || this.pending !== pending) throw new Error("登录已结束。");
        // Ignore unsolicited local requests without consuming the real attempt.
        if (new URL(url).searchParams.get("state") !== attempt.state) throw new Error("登录校验失败。");
        handling = true;
        try {
          const form = consumeCallback(attempt, url);
          if (!account?.subject) this.host.setPref("chatgptPendingClient", form.client_id);
          const tokens = await this.http(this.window, TOKEN, form);
          const identity = await verifyIdentity(tokens.id_token, await this.keys(), form.client_id, attempt.nonce, account?.subject);
          const record = tokenRecord(tokens, { ...identity, client_id: form.client_id });
          if (pending.cancelled || this.pending !== pending) throw new Error("登录已取消。");
          await this.put(record); this.host.setPref("chatgptPendingClient", ""); this.select(record.client_id); resolve(record.email);
        } catch (error) { reject(new Error(error.code ? "登录身份校验失败，请重试。" : error.message)); throw error; }
      });
      attempt = await newAttempt(this.window.crypto, listener.redirectURI, hostID, account);
      if (pending.cancelled) throw new Error("登录已取消。");
      timer = this.window.setTimeout(() => { pending.cancelled = true; reject(new Error("登录等待已过期，请重新登录。")); }, 10 * 60 * 1000);
      this.host.openExternal(authorizationURL(attempt));
      return await done;
    } finally {
      this.window.clearTimeout(timer);
      // Let the callback response flush before closing its socket.
      this.window.setTimeout(() => listener?.close(), 100);
      if (this.pending === pending) this.pending = null;
      this.changed();
    }
  }
  async accessToken() {
    if (this.signingOut) throw new Error("账号正在退出，请稍后重新登录。");
    const account = this.current();
    if (!account?.access_token) throw new Error("请先登录 ChatGPT 账号。");
    if (account.expires_at > Date.now() + 60000) return account.access_token;
    if (!account.refresh_token) throw new Error("ChatGPT 登录已过期，请重新登录。");
    const id = account.client_id;
    if (!this.refreshes.has(id)) {
      const epoch = this.epochs.get(id);
      this.refreshes.set(id, (async () => {
        const tokens = await this.http(this.window, TOKEN, { grant_type: "refresh_token", client_id: id, refresh_token: account.refresh_token, resource: RESOURCE });
        if (tokens.id_token) await verifyIdentity(tokens.id_token, await this.keys(), id, undefined, account.subject);
        const record = tokenRecord(tokens, account);
        if (this.epochs.get(id) !== epoch) throw new Error("账号已退出，请重新登录。");
        await this.put(record); return record.access_token;
      })().finally(() => this.refreshes.delete(id)));
    }
    return this.refreshes.get(id);
  }
  async signOut() {
    const account = this.current(); if (!account) return;
    this.signingOut = true; this.changed();
    const id = account.client_id;
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
    let revoked = !account.refresh_token;
    try {
      if (account.refresh_token) {
        const discovery = await this.http(this.window, `${ISSUER}/.well-known/openid-configuration`);
        if (new URL(discovery.revocation_endpoint).origin !== ISSUER) throw new Error("撤销地址不匹配。");
        await this.http(this.window, discovery.revocation_endpoint, { token: account.refresh_token, token_type_hint: "refresh_token", client_id: id });
        revoked = true;
      }
    } catch {} finally {
      await this.put({ client_id: id, subject: account.subject, issuer: account.issuer, email: account.email }); this.signingOut = false; this.changed();
    }
    return revoked;
  }
  destroy() { this.pending?.cancel(); for (const id of this.refreshes.keys()) this.epochs.set(id, (this.epochs.get(id) || 0) + 1); this.listeners.clear(); }
}
