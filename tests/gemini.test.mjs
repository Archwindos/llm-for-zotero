import test from "node:test";
import assert from "node:assert/strict";
import { streamGemini, listGeminiModels } from "../src/gemini.mjs";
import { streamModel } from "../src/providers.mjs";
import { runtime, flush } from "./helpers.mjs";

test("Gemini 3.8 high uses Google's headers and thinking config without OpenAI or DeepSeek parameters", async t => {
  const r = runtime(t, { panel: false }), visible = [];
  const request = streamGemini({ window: r.dom.window, key: "fake-google", model: "gemini-3.8-flash", thinkingLevel: "high", messages: [{ role: "user", content: "question" }, { role: "assistant", content: "old answer" }], onText: text => visible.push(text) });
  const xhr = r.requests[0], body = JSON.parse(xhr.body);
  assert.match(xhr.url, /models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(xhr.headers["x-goog-api-key"], "fake-google"); assert.equal(xhr.headers.Authorization, undefined);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "HIGH" }); assert.equal(body.contents[1].role, "model");
  assert.ok(!xhr.body.includes("fake-google")); assert.equal(body.tools, undefined); assert.equal(body.service_tier, undefined);
  xhr.push({ candidates: [{ content: { parts: [{ text: "private thought", thought: true }, { text: "answer" }] } }] }); assert.deepEqual(visible, ["answer"]);
  xhr.push({ candidates: [{ finishReason: "STOP" }], modelVersion: "gemini-3.8-flash" }); assert.equal(await request.promise, "answer");
});

test("Gemini incomplete, blocked and interrupted responses never become completed answers", async t => {
  const r = runtime(t, { panel: false });
  for (const event of [{ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] }, { promptFeedback: { blockReason: "SAFETY" } }, { candidates: [{ content: { parts: [{ text: "partial" }] } }] }]) {
    const request = streamGemini({ window: r.dom.window, key: "fake", messages: [], onText() {} }); const xhr = r.requests.at(-1); xhr.push(event); xhr.onload(); await assert.rejects(request.promise);
  }
});

test("Gemini cancellation rejects immediately and ignores late text", async t => {
  const r = runtime(t, { panel: false }), visible = [];
  const request = streamGemini({ window: r.dom.window, key: "fake", messages: [], onText: text => visible.push(text) });
  request.cancel(); await assert.rejects(request.promise, { name: "AbortError" }); r.requests[0].push({ candidates: [{ content: { parts: [{ text: "late" }] }, finishReason: "STOP" }] }); assert.deepEqual(visible, []);
});

test("Gemini model discovery follows pagination and removes models that need non-text input", async t => {
  const r = runtime(t, { panel: false }), request = listGeminiModels(r.dom.window, "fake-google");
  r.requests[0].load({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "page 2" }); await flush();
  assert.match(r.requests[1].url, /pageToken=page%202/);
  r.requests[1].load({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] });
  assert.deepEqual((await request.promise).map(m => m.id), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("dispatcher isolates manufacturer-specific parameters and never switches the requested manufacturer", async t => {
  const r = runtime(t, { panel: false });
  for (const profile of r.host.profiles()) {
    const request = streamModel({ window: r.dom.window, key: "fake", profile, messages: [], onText() {} });
    const xhr = r.requests.at(-1), body = JSON.parse(xhr.body);
    if (profile.provider === "gemini") { assert.equal(body.service_tier, undefined); assert.equal(body.thinking, undefined); }
    else if (profile.provider === "deepseek") { assert.equal(body.service_tier, undefined); assert.equal(body.thinking.type, "disabled"); assert.equal(body.generationConfig, undefined); }
    else { assert.equal(body.service_tier, profile.options.fast ? "priority" : "default"); assert.equal(body.generationConfig, undefined); assert.equal(body.thinking, undefined); }
    request.cancel(); await assert.rejects(request.promise);
  }
});

test("Gemini sends original PDF inlineData with its text question and historical turns", async t => {
  const r = runtime(t, { panel: false }), bytes = Buffer.from([37, 80, 68, 70, 45, 49, 10, 0, 255, 128]);
  const pdf = { filename: "paper.pdf", mimeType: "application/pdf", size: bytes.length, data: bytes.toString("base64") };
  const request = streamGemini({ window: r.dom.window, key: "fake-google", messages: [{ role: "user", content: "explain", pdf }, { role: "assistant", content: "previous" }], onText() {} });
  const xhr = r.requests[0], body = JSON.parse(xhr.body);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: pdf.data } }, { text: "explain" }] }, { role: "model", parts: [{ text: "previous" }] }]);
  assert.deepEqual(Buffer.from(body.contents[0].parts[0].inlineData.data, "base64"), bytes);
  xhr.status = 400; xhr.onload(); await assert.rejects(request.promise, /PDF.*支持文档/);
});
