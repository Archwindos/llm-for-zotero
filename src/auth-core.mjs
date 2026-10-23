import { createLocalJWKSet, jwtVerify } from "jose";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export function randomURLValue(crypto) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function newAttempt(crypto, redirectURI, hostID, account) {
  const verifier = randomURLValue(crypto);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge, redirectURI, hostID, state: randomURLValue(crypto), nonce: randomURLValue(crypto),
    expiresAt: Date.now() + 10 * 60 * 1000, account, consumed: false };
}

export function authorizationURL(attempt) {
  const p = new URLSearchParams({ client_id: attempt.account?.client_id || "dynamic_agent_client", ext_agent_host_id: attempt.hostID,
    response_type: "code", redirect_uri: attempt.redirectURI, scope: SCOPES, resource: RESOURCE,
    state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256", code_challenge: attempt.challenge });
  if (!attempt.account) p.set("agent_name_hint", "LLM for Zotero");
  else if (attempt.account.id_token) p.set("id_token_hint", attempt.account.id_token);
  return `${AUTHORIZE}?${p}`;
}

export function consumeCallback(attempt, url) {
  const callback = new URL(url), expected = new URL(attempt.redirectURI);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || attempt.consumed ||
    Date.now() >= attempt.expiresAt || callback.searchParams.get("state") !== attempt.state) {
    throw new Error("登录校验失败或已过期，请重新登录。");
  }
  attempt.consumed = true;
  if (callback.searchParams.has("error")) throw new Error("登录未获授权。可重新登录，并允许本插件使用 ChatGPT 套餐。");
  const code = callback.searchParams.get("code");
  const clientID = callback.searchParams.get("client_id") || attempt.account?.client_id;
  if (!code || !clientID || clientID === "dynamic_agent_client" ||
    (attempt.account && clientID !== attempt.account.client_id)) throw new Error("登录返回的应用注册信息不匹配，请重试。");
  return { grant_type: "authorization_code", client_id: clientID, code, code_verifier: attempt.verifier,
    redirect_uri: attempt.redirectURI, resource: RESOURCE };
}

export async function verifyIdentity(token, jwks, clientID, nonce, subject) {
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: ISSUER, audience: clientID, algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5
  });
  if ((nonce !== undefined && payload.nonce !== nonce) || typeof payload.sub !== "string" || !payload.sub || (subject && payload.sub !== subject)) {
    throw new Error("登录身份校验失败，请重新登录。");
  }
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : "ChatGPT 账号", issuer: ISSUER };
}

export function tokenRecord(tokens, previous = {}, now = Date.now()) {
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : previous.scopes || [];
  if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("此登录尚未允许使用 ChatGPT 套餐，请重新授权。");
  if (typeof tokens.access_token !== "string" || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
    tokens.token_type?.toLowerCase() !== "bearer") throw new Error("登录服务返回的凭据不完整，请重试。");
  return { ...previous, access_token: tokens.access_token, refresh_token: tokens.refresh_token || previous.refresh_token,
    id_token: tokens.id_token || previous.id_token, scopes, expires_at: now + tokens.expires_in * 1000 };
}
