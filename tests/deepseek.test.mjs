import test from "node:test";
import assert from "node:assert/strict";
import { streamDeepSeekTranslation, listDeepSeekModels } from "../src/deepseek.mjs";

function runtime() {
  let xhr;
  const window = { XMLHttpRequest: class {
    constructor(options) { xhr = this; this.options = options; this.headers = {}; this.status = 200; this.responseText = ""; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
    push(event) { this.responseText += `data: ${JSON.stringify(event)}\n\n`; this.onprogress?.(); }
  } };
  const visible = [];
  return { window, visible, get xhr() { return xhr; }, start: () => streamDeepSeekTranslation({ window, key: "fake-deepseek-key", messages: [{ role: "user", content: "Translate this." }], onText: text => visible.push(text) }) };
}

test("DeepSeek translation disables thinking and all tools and streams visible text immediately", async () => {
  const r = runtime(), request = r.start(), body = JSON.parse(r.xhr.body);
  assert.equal(r.xhr.url, "https://api.deepseek.com/chat/completions");
  assert.equal(r.xhr.headers.Authorization, "Bearer fake-deepseek-key");
  assert.equal(r.xhr.options.mozAnon, true);
  assert.equal(body.model, "deepseek-flash"); assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.tool_choice, "none");
  for (const name of ["tools", "reasoning_effort", "service_tier", "web_search"]) assert.equal(body[name], undefined);
  assert.ok(!r.xhr.body.includes("fake-deepseek-key")); assert.match(body.messages[0].content, /只输出译文/);
  r.xhr.push({ choices: [{ delta: { reasoning_content: "never show this" } }] }); assert.equal(r.visible.length, 0);
  r.xhr.push({ choices: [{ delta: { content: "译" } }] }); assert.deepEqual(r.visible, ["译"]);
  r.xhr.push({ choices: [{ delta: { content: "文" }, finish_reason: "stop" }] });
  assert.equal(await request.promise, "译文"); // Does not wait for the HTTP socket to close.
});

test("DeepSeek never treats an interrupted or truncated stream as complete", async () => {
  for (const reason of [null, "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted"]) {
    const r = runtime(), request = r.start();
    r.xhr.push({ choices: [{ delta: { content: "partial" }, finish_reason: reason }] }); r.xhr.onload();
    await assert.rejects(request.promise, /未完成|不完整/);
  }
});

test("DeepSeek accepts an explicit DONE marker after content without waiting for socket close", async () => {
  const r = runtime(), request = r.start();
  r.xhr.push({ choices: [{ delta: { content: "完整译文" } }] });
  r.xhr.responseText += "data: [DONE]\n\n"; r.xhr.onprogress();
  assert.equal(await request.promise, "完整译文");
  r.xhr.push({ choices: [{ delta: { content: "late" } }] });
  assert.deepEqual(r.visible, ["完整译文"]);
});

test("DeepSeek keep-alive comments and an empty DONE do not produce a successful translation", async () => {
  const r = runtime(), request = r.start();
  r.xhr.responseText = ": keep-alive\n\n"; r.xhr.onprogress(); assert.equal(r.visible.length, 0);
  r.xhr.responseText += "data: [DONE]\n\n"; r.xhr.onprogress();
  await assert.rejects(request.promise, /未返回正文/);
});

test("DeepSeek cancellation rejects promptly and ignores late content", async () => {
  const r = runtime(), request = r.start(); request.cancel();
  await assert.rejects(request.promise, { name: "AbortError" });
  r.xhr.push({ choices: [{ delta: { content: "late" }, finish_reason: "stop" }] }); assert.deepEqual(r.visible, []);
});

test("DeepSeek errors give provider-specific guidance without revealing provider payloads", async () => {
  for (const [status, expected] of [[401, /Key/], [402, /余额/], [429, /频繁/]]) {
    const r = runtime(), request = r.start(); r.xhr.status = status;
    r.xhr.responseText = '{"error":{"message":"private token or text"}}'; r.xhr.onload();
    await assert.rejects(request.promise, error => expected.test(error.message) && !error.message.includes("private"));
  }
});

test("DeepSeek model discovery uses only its own credential and excludes the legacy reasoning model", async () => {
  const r = runtime(), request = listDeepSeekModels(r.window, "fake-deepseek-key");
  assert.equal(r.xhr.url, "https://api.deepseek.com/models"); assert.equal(r.xhr.method, "GET");
  r.xhr.responseText = JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-reasoner" }, { id: "deepseek-flash" }] });
  r.xhr.onload(); assert.deepEqual((await request.promise).map(m => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
});
