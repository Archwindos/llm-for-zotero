import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { newAttempt, authorizationURL, consumeCallback, verifyIdentity, tokenRecord, ISSUER, SCOPES } from "../src/auth-core.mjs";
import { ChatGPTAuth } from "../src/auth.mjs";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" }] };
const sign = (nonce, claims = {}) => new SignJWT({ nonce, email: "reader@example.test", ...claims }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
  .setIssuer(ISSUER).setAudience("oaiapp_test").setSubject("test-user").setIssuedAt().setExpirationTime("1h").sign(privateKey);
const start = () => newAttempt(crypto, "http://127.0.0.1:3333/auth/callback", "urn:uuid:host", undefined);
const tokens = id_token => ({ access_token: "fake-access", refresh_token: "fake-refresh", id_token, token_type: "Bearer", expires_in: 3600, scope: SCOPES });

test("sign-in uses random state, nonce and S256, with dynamic registration only for new accounts", async () => {
  const a = await start(), b = await start(); assert.notEqual(a.state, b.state); assert.notEqual(a.nonce, a.state);
  const url = new URL(authorizationURL(a)); assert.equal(url.origin, ISSUER); assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("agent_name_hint"), "LLM for Zotero");
  assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  a.account = { client_id: "oaiapp_test", id_token: "fake-id" };
  const again = new URL(authorizationURL(a)); assert.equal(again.searchParams.get("client_id"), "oaiapp_test"); assert.ok(!again.searchParams.has("agent_name_hint"));
});
test("callback rejects missing state, code, issued client, expiry, reused callback and registration mismatch", async () => {
  for (const mutation of [u => u.searchParams.delete("state"), u => u.searchParams.delete("code"), u => u.searchParams.delete("client_id"), u => u.hostname = "localhost"]) {
    const a = await start(), u = new URL(`${a.redirectURI}?state=${a.state}&code=fake&client_id=oaiapp_test`); mutation(u); assert.throws(() => consumeCallback(a, u));
  }
  const a = await start(), url = `${a.redirectURI}?state=${a.state}&code=fake&client_id=oaiapp_test`;
  const form = consumeCallback(a, url); assert.equal(form.client_id, "oaiapp_test"); assert.equal(form.redirect_uri, a.redirectURI); assert.equal(form.code_verifier, a.verifier);
  assert.throws(() => consumeCallback(a, url));
  const b = await start(); b.expiresAt = 1; assert.throws(() => consumeCallback(b, `${b.redirectURI}?state=${b.state}&code=fake&client_id=oaiapp_test`));
  const c = await start(); c.account = { client_id: "original" }; assert.throws(() => consumeCallback(c, `${c.redirectURI}?state=${c.state}&code=fake&client_id=different`));
});
test("ID token verification checks signed identity, audience and original nonce", async () => {
  const jwt = await sign("n"); assert.equal((await verifyIdentity(jwt, jwks, "oaiapp_test", "n")).subject, "test-user");
  await assert.rejects(verifyIdentity(jwt, jwks, "wrong-client", "n"));
  await assert.rejects(verifyIdentity(jwt, jwks, "oaiapp_test", "wrong-nonce"));
  await assert.rejects(verifyIdentity(jwt, jwks, "oaiapp_test", "n", "other-account"));
  const parts = jwt.split("."); parts[1] = Buffer.from('{"sub":"attacker"}').toString("base64url");
  await assert.rejects(verifyIdentity(parts.join("."), jwks, "oaiapp_test", "n"));
});
test("identity alone never authorizes inference and rotating tokens preserve granted scopes", () => {
  assert.throws(() => tokenRecord({ ...tokens("fake"), scope: "openid email" }), /套餐/);
  const record = tokenRecord(tokens("fake"), { client_id: "oaiapp_test" }, 1000);
  assert.equal(record.expires_at, 3601000);
  const refreshed = tokenRecord({ access_token: "replacement", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 }, record);
  assert.equal(refreshed.refresh_token, "new-refresh"); assert.deepEqual(refreshed.scopes, record.scopes);
});

function runtime(initial = []) {
  let records = initial, opened, callback, closes = 0;
  const prefs = new Map(initial.length ? [["chatgptAccount", initial[0].client_id]] : []), requests = [];
  const host = { window: { crypto, setTimeout, clearTimeout }, getPref: (n, d) => prefs.get(n) ?? d, setPref: (n, v) => prefs.set(n, v),
    getAccounts: () => records, setAccounts: async value => { records = value; }, openExternal: url => { opened = new URL(url); } };
  const auth = new ChatGPTAuth(host, { listen: (_window, fn) => { callback = fn; return { redirectURI: "http://127.0.0.1:3333/auth/callback", close: () => closes++ }; },
    http: async (_window, url, form) => {
      requests.push({ url, form }); if (url.includes("jwks")) return jwks;
      return tokens(await sign(opened?.searchParams.get("nonce")));
    } });
  return { auth, host, requests, get records() { return records; }, get opened() { return opened; }, get closes() { return closes; }, callback: url => callback(url) };
}
async function waitURL(r) { for (let i = 0; i < 20 && !r.opened; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(r.opened); }
test("full OAuth lifecycle stores only validated credentials, reuses host and clears pending attempt", async () => {
  const r = runtime(), login = r.auth.signIn(); await waitURL(r);
  const state = r.opened.searchParams.get("state"), hostID = r.host.getPref("chatgptHostID");
  await assert.rejects(r.callback("http://127.0.0.1:3333/auth/callback?state=bad&code=x")); assert.equal(r.requests.length, 0);
  await r.callback(`http://127.0.0.1:3333/auth/callback?state=${state}&code=fake&client_id=oaiapp_test`);
  assert.equal(await login, "reader@example.test"); assert.equal(r.auth.pending, null); assert.equal(r.records[0].subject, "test-user");
  assert.equal(await r.auth.accessToken(), "fake-access"); assert.equal(r.host.getPref("chatgptHostID"), hostID); r.auth.destroy();
});
test("cancelled login never replaces the selected account", async () => {
  const r = runtime(), login = r.auth.signIn(); await waitURL(r); r.auth.pending.cancel();
  await assert.rejects(login, /取消/); assert.equal(r.records.length, 0); assert.equal(r.auth.pending, null); r.auth.destroy();
});
test("concurrent token refresh is serialized, and sign-out during refresh cannot resurrect credentials", async () => {
  const original = tokenRecord(tokens("fake-id"), { client_id: "oaiapp_test", subject: "test-user" }); original.expires_at = 0;
  const r = runtime([original]); let finish, calls = 0;
  r.auth.http = async (_w, url, form) => { if (form?.grant_type === "refresh_token") { calls++; return new Promise(resolve => { finish = resolve; }); }
    if (url.includes("openid-configuration")) return { revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` }; return {}; };
  const one = r.auth.accessToken(), two = r.auth.accessToken(); assert.equal(calls, 1);
  await r.auth.signOut(); finish({ ...tokens(undefined), id_token: undefined });
  await assert.rejects(one, /退出/); await assert.rejects(two, /退出/); assert.equal(r.records[0].access_token, undefined); r.auth.destroy();
});
