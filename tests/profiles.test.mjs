import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, migrateProfiles } from "../src/profiles.mjs";
import { runtime } from "./helpers.mjs";

test("legacy preferences migrate once, preserving translation and choosing Gemini 3.8 high for new chat default", t => {
  const { host } = runtime(t, { panel: false, migration: true });
  host.setPref("translationProvider", "deepseek"); host.setPref("deepseekTranslationModel", "deepseek-flash");
  host.setPref("chatgptModel", "existing-model"); host.setPref("effort", "xhigh"); host.setPref("fast", true);
  const profiles = migrateProfiles(host); assert.equal(profiles.length, 4);
  assert.equal(host.taskProfile("translation").provider, "deepseek"); assert.equal(host.taskProfile("translation").options.thinking, false);
  assert.equal(host.taskProfile("chat").model, "gemini-3.8-flash"); assert.deepEqual(host.taskProfile("chat").options, { thinkingLevel: "high" });
  const old = profiles.find(p => p.id === "openai-existing"); assert.equal(old.model, "existing-model"); assert.equal(old.options.effort, "xhigh"); assert.equal(old.options.fast, true);
  host.setPref("chatProfileID", "openai-existing"); migrateProfiles(host); assert.equal(host.taskProfile("chat").id, "openai-existing");
});

test("profile serialization discards secrets and parameters that belong to another manufacturer", () => {
  const gemini = normalizeProfile({ id: "test", name: "Gemini", provider: "gemini", model: "models/gemini-3.8-flash", key: "fake-secret", options: { thinkingLevel: "high", fast: true, effort: "max", token: "fake" } });
  assert.equal(gemini.model, "gemini-3.8-flash"); assert.deepEqual(gemini.options, { thinkingLevel: "high" }); assert.ok(!JSON.stringify(gemini).includes("fake"));
  const deepseek = normalizeProfile({ ...gemini, provider: "deepseek", model: "deepseek-flash", options: { fast: true } }); assert.deepEqual(deepseek.options, { thinking: false, effort: "high" });
});

test("named profiles can reuse a manufacturer while preserving independent task selection", t => {
  const { host } = runtime(t, { panel: false });
  host.saveProfile({ id: "gemini-low", name: "Gemini 快问", provider: "gemini", model: "gemini-3.8-flash", options: { thinkingLevel: "low" } });
  host.setPref("translationProfileID", "gemini-low");
  assert.equal(host.taskProfile("translation").options.thinkingLevel, "low"); assert.equal(host.taskProfile("chat").options.thinkingLevel, "high");
  assert.throws(() => host.deleteProfile("gemini-low"), /正在使用/);
  host.setPref("translationProfileID", "deepseek"); host.deleteProfile("gemini-low"); assert.ok(!host.profiles().some(p => p.id === "gemini-low"));
});

test("unknown manufacturers, invalid model names, and incompatible reasoning values fail before a request", () => {
  const base = { id: "a", name: "name", provider: "gemini", model: "gemini-3.8-flash", options: {} };
  for (const change of [{ provider: "unknown" }, { model: "../../?key=secret" }, { name: "" }, { options: { thinkingLevel: "ultra" } }]) assert.throws(() => normalizeProfile({ ...base, ...change }));
});
