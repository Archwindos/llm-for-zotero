import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("bootstrap provides the Web APIs needed to validate signed identities in a plugin sandbox", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "bootstrap", alg: "RS256", use: "sig" }] };
  const token = await new SignJWT({ nonce: "test" }).setProtectedHeader({ alg: "RS256", kid: "bootstrap" })
    .setIssuer("https://auth.openai.com").setAudience("oaiapp_test").setSubject("reader").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const { outputFiles } = await build({ entryPoints: ["src/auth-core.mjs"], bundle: true, write: false, format: "iife", globalName: "AuthBootstrapTest", target: "firefox140" });
  const window = { crypto, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, structuredClone };
  const scope = vm.createContext({ Uint8Array, ArrayBuffer, crypto, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob,
    Zotero: { initializationPromise: Promise.resolve(), uiReadyPromise: Promise.resolve(), getMainWindow: () => window },
    Services: { scriptloader: { loadSubScript(_uri, target) { target.GPTForZotero = { start: async () => {} }; } } }
  });
  vm.runInContext(outputFiles[0].text, scope);
  // Reproduces the misleading JWK error when the host omits structuredClone.
  await assert.rejects(scope.AuthBootstrapTest.verifyIdentity(token, jwks, "oaiapp_test", "test"), /JSON Web Key Set malformed/);
  vm.runInContext(await readFile(new URL("../addon/bootstrap.js", import.meta.url), "utf8"), scope);
  await scope.startup({ rootURI: "test:/", version: "test" });
  assert.equal((await scope.AuthBootstrapTest.verifyIdentity(token, jwks, "oaiapp_test", "test")).subject, "reader");
  await assert.rejects(scope.AuthBootstrapTest.verifyIdentity(token, jwks, "wrong-client", "test"));
  const parts = token.split("."); parts[1] = Buffer.from('{"sub":"attacker"}').toString("base64url");
  await assert.rejects(scope.AuthBootstrapTest.verifyIdentity(parts.join("."), jwks, "oaiapp_test", "test"));
});
