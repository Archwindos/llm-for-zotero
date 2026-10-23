import test from "node:test";
import assert from "node:assert/strict";
import { SelectionTranslator } from "../src/selection.mjs";
import { runtime, pause } from "./helpers.mjs";

function setup(t, { request, key = true, auto = true } = {}) {
  const r = runtime(t, { panel: false, keys: key }), calls = [], chats = [], reader = { itemID: 9 };
  r.host.setPref("autoTranslate", auto);
  const translator = new SelectionTranslator({ host: r.host, delay: 5, detachDelay: 10,
    openSettings() {}, openChat: selection => chats.push(selection), request: request || (options => {
      calls.push(options); options.onText("译文"); options.onComplete({ tier: "default" }); return { promise: Promise.resolve("译文"), cancel() {} };
    }) });
  const render = (text = "Selected text") => {
    translator.render({ doc: r.dom.window.document, reader, params: { annotation: { text, pageLabel: "2" } }, append: node => r.dom.window.document.body.append(node) });
    return r.dom.window.document.body.lastChild;
  };
  t.after(() => translator.destroy());
  return { ...r, translator, calls, chats, reader, render };
}

test("DeepSeek translation uses its independent profile, credentials, instructions, and completed cache", async t => {
  const r = setup(t), node = r.render(); await pause();
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].profile.provider, "deepseek");
  assert.equal(r.calls[0].profile.options.thinking, false); assert.equal(r.calls[0].key, "fake-deepseek");
  assert.match(r.calls[0].instructions, /只输出译文/); assert.match(node.textContent, /DeepSeek 快译/);
  node.querySelector("button").click(); await pause(); assert.deepEqual(r.chats[0], { text: "Selected text", itemID: 9, page: "2" });
  r.render(); await pause(); assert.equal(r.calls.length, 1); assert.match(r.dom.window.document.body.lastChild.textContent, /已缓存/);
});

test("rapid selection changes only send the final settled text", async t => {
  const r = setup(t); r.render("old"); r.render("final"); await pause();
  assert.equal(r.calls.length, 1); assert.match(r.calls[0].messages[0].content, /final/);
});

test("changing translation options or key invalidates its cache, while chat changes do not", async t => {
  const r = setup(t); r.render(); await pause();
  r.host.setPref("chatProfileID", "openai"); r.render(); await pause(); assert.equal(r.calls.length, 1);
  const profile = r.host.taskProfile("translation"); r.host.saveProfile({ ...profile, options: { thinking: true, effort: "low" } });
  r.render(); await pause(); assert.equal(r.calls.length, 2); assert.equal(r.calls[1].profile.options.thinking, true);
  await r.host.setKey("fake-replacement", "deepseek"); r.render(); await pause(); assert.equal(r.calls.length, 3);
  assert.equal(r.calls[2].key, "fake-replacement");
});

test("closing a popup cancels the request and prevents late output", async t => {
  let finish, cancelled = 0;
  const r = setup(t, { request: () => ({ promise: new Promise(resolve => { finish = resolve; }), cancel() { cancelled++; } }) });
  const node = r.render(); await pause(); node.remove(); await pause(); assert.equal(cancelled, 1);
  finish("late answer"); await pause(); assert.ok(!node.textContent.includes("late answer")); assert.equal(r.translator.active.size, 0);
});

test("a popup briefly removed during reader layout continues its active translation", async t => {
  let finish, cancelled = 0;
  const r = setup(t, { request: () => ({ promise: new Promise(resolve => { finish = resolve; }), cancel() { cancelled++; } }) });
  const node = r.render(); await pause(); node.remove(); await new Promise(resolve => setTimeout(resolve, 2));
  r.dom.window.document.body.append(node); await pause(); finish("完整译文"); await pause();
  assert.equal(cancelled, 0); assert.match(node.textContent, /完整译文/);
});

test("missing DeepSeek key never falls back to another provider, and disabling auto sends nothing", async t => {
  const r = setup(t, { key: false }); const node = r.render(); await pause(); assert.equal(r.calls.length, 0); assert.match(node.textContent, /DeepSeek/);
  r.host.setPref("autoTranslate", false); const disabled = r.render("another"); await pause(); assert.equal(r.calls.length, 0); assert.match(disabled.textContent, /已关闭/);
});

test("translation route can select Gemini high independently of a ChatGPT chat route", async t => {
  const r = setup(t); r.host.setPref("translationProfileID", "gemini"); r.host.setPref("chatProfileID", "chatgpt");
  r.render(); await pause(); assert.equal(r.calls[0].profile.provider, "gemini"); assert.equal(r.calls[0].profile.options.thinkingLevel, "high"); assert.equal(r.calls[0].key, "fake-gemini");
});

test("closing a popup while acquiring credentials prevents late inference", async t => {
  const r = setup(t); let finish; r.host.credential = () => new Promise(resolve => { finish = resolve; });
  const node = r.render(); await pause(); node.remove(); await pause(); finish("fake"); await pause(); assert.equal(r.calls.length, 0);
});

test("failed partial output is visible as incomplete, is not cached, and can be retried", async t => {
  let count = 0;
  const r = setup(t, { request: options => {
    count++; options.onText("前半句"); return { promise: Promise.reject(new Error("连接中断")), cancel() {} };
  } });
  const node = r.render(); await pause(); assert.match(node.textContent, /未完成/); assert.equal(r.translator.cache.size, 0);
  const retry = [...node.querySelectorAll("button")].find(button => button.textContent === "重试翻译");
  assert.equal(retry.hidden, false); retry.click(); await pause(); assert.equal(count, 2);
});

test("a profile change during credential acquisition cannot send the previous provider request", async t => {
  const r = setup(t); let finish; r.host.credential = () => new Promise(resolve => { finish = resolve; });
  const node = r.render(); await pause(); r.host.setPref("translationProfileID", "gemini"); finish("fake"); await pause();
  assert.equal(r.calls.length, 0); assert.match(node.textContent, /配置或账号已改变/);
});
