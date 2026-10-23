import test from "node:test";
import assert from "node:assert/strict";
import { streamResponse, checkKey, listModels } from "../src/api.mjs";

function runtime() {
  let xhr;
  class FakeXHR {
    constructor(options) { xhr = this; this.options = options; this.headers = {}; this.status = 200; this.responseText = ""; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
    push(event) { this.responseText += `data: ${JSON.stringify(event)}\n\n`; this.onprogress?.(); }
  }
  const window = { XMLHttpRequest: FakeXHR };
  const start = () => streamResponse({ window, key: "fake-key", model: "test-model", messages: [{ role: "user", content: "question" }], onText() {} });
  return { window, start, get xhr() { return xhr; } };
}
test("API targets official Responses endpoint and never stores remotely by request", async () => {
  const r = runtime(), request = r.start();
  assert.equal(r.xhr.url, "https://api.openai.com/v1/responses");
  assert.equal(r.xhr.options.mozAnon, true);
  const body = JSON.parse(r.xhr.body);
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.ok(!r.xhr.body.includes("fake-key"));
  r.xhr.push({ type: "response.output_text.delta", delta: "answer" });
  r.xhr.push({ type: "response.completed" }); r.xhr.onload();
  assert.equal(await request.promise, "answer");
});
test("cut-off streams do not masquerade as complete answers", async () => {
  const r = runtime(), request = r.start();
  r.xhr.push({ type: "response.output_text.delta", delta: "partial" }); r.xhr.onload();
  await assert.rejects(request.promise, /中断/);
});
test("cancellation rejects promptly", async () => {
  const r = runtime(), request = r.start(); request.cancel();
  await assert.rejects(request.promise, { name: "AbortError" });
});
test("rate-limit message is useful and never echoes provider error payload", async () => {
  const r = runtime(), request = r.start(); r.xhr.status = 429;
  r.xhr.responseText = '{"error":"sensitive-content"}'; r.xhr.onload();
  await assert.rejects(request.promise, e => /额度/.test(e.message) && !e.message.includes("sensitive-content"));
});
test("failed and incomplete streaming events reject even after partial output", async () => {
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    const r = runtime(), request = r.start(); r.xhr.push({ type: "response.output_text.delta", delta: "partial" }); r.xhr.push({ type });
    await assert.rejects(request.promise);
  }
});
test("key test reads models without generating paid output", async () => {
  const r = runtime(); const request = checkKey(r.window, "fake-key");
  assert.equal(r.xhr.method, "GET"); assert.match(r.xhr.url, /\/models$/);
  r.xhr.responseText = '{"data":[{"id":"b"},{"id":"a"}]}'; r.xhr.onload();
  assert.deepEqual(await request.promise, ["a", "b"]);
});
test("chat settings are real request parameters and returned Fast downgrade is exposed", async () => {
  const r = runtime(); let meta;
  const req = streamResponse({ window: r.window, key: "fake", model: "gpt-6.1-sol", effort: "high", fast: true, messages: [], onText() {}, onComplete: m => { meta = m; } });
  const body = JSON.parse(r.xhr.body);
  assert.deepEqual(body.reasoning, { effort: "high" }); assert.equal(body.service_tier, "priority");
  for (const skill of ["读论文", "讲原理", "说人话"]) assert.ok(body.instructions.includes(skill));
  r.xhr.push({ type: "response.completed", response: { service_tier: "default", output: [{ content: [{ text: "answer" }] }] } }); r.xhr.onload();
  await req.promise; assert.equal(meta.tier, "default");
});
test("Fast off explicitly requests standard and default effort omits unsupported reasoning", async () => {
  const r = runtime(); const req = streamResponse({ window: r.window, key: "fake", model: "gpt-4.1", effort: "default", fast: false, messages: [], onText() {} });
  const body = JSON.parse(r.xhr.body); assert.equal(body.reasoning, undefined); assert.equal(body.service_tier, "default");
  req.cancel(); await assert.rejects(req.promise);
});
test("ChatGPT catalog preserves server order and excludes hidden models", async () => {
  const r = runtime(), req = listModels(r.window, "fake-account-token", "chatgpt");
  r.xhr.responseText = JSON.stringify({ models: [{ slug: "z-model", display_name: "Primary", visibility: "list" }, { slug: "hidden", visibility: "hide" }, { slug: "a-model", visibility: "list" }] });
  r.xhr.onload(); assert.deepEqual(await req.promise, [{ id: "z-model", name: "Primary" }, { id: "a-model", name: "a-model" }]);
});
test("ChatGPT account uses public Responses with permitted fields and actionable plan errors", async () => {
  const r = runtime(), req = streamResponse({ window: r.window, mode: "chatgpt", key: "fake-account-token", model: "account-model", effort: "medium", fast: true, messages: [], onText() {} });
  assert.equal(r.xhr.headers.Authorization, "Bearer fake-account-token");
  assert.match(r.xhr.url, /^https:\/\/api.openai.com\/v1\/responses$/);
  const body = JSON.parse(r.xhr.body); assert.equal(body.stream, true); assert.equal(body.store, false); assert.ok(Array.isArray(body.input));
  for (const forbidden of ["max_output_tokens", "previous_response_id", "temperature", "metadata", "background"]) assert.equal(body[forbidden], undefined);
  r.xhr.push({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "private" } } });
  await assert.rejects(req.promise, e => /管理用量/.test(e.message) && !e.message.includes("private"));
});

test("OpenAI and ChatGPT send actual PDFs using official input_file data URIs and preserve text turns", async () => {
  const bytes = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 128]);
  for (const mode of ["api", "chatgpt"]) {
    const r = runtime(), pdf = { filename: "whole.pdf", mimeType: "application/pdf", size: bytes.length, data: bytes.toString("base64") };
    const request = streamResponse({ window: r.window, key: "fake", model: "vision-model", mode,
      messages: [{ role: "user", content: "question", pdf }, { role: "assistant", content: "old answer" }, { role: "user", content: "follow up" }], onText() {} });
    const body = JSON.parse(r.xhr.body);
    assert.equal(r.xhr.url, "https://api.openai.com/v1/responses");
    assert.deepEqual(body.input[0], { role: "user", content: [{ type: "input_file", filename: "whole.pdf", file_data: `data:application/pdf;base64,${pdf.data}` }, { type: "input_text", text: "question" }] });
    assert.deepEqual(body.input.slice(1), [{ role: "assistant", content: "old answer" }, { role: "user", content: "follow up" }]);
    assert.deepEqual(Buffer.from(body.input[0].content[0].file_data.split(",")[1], "base64"), bytes);
    r.xhr.status = 413; r.xhr.onload(); await assert.rejects(request.promise, /PDF.*大小/);
  }
});
