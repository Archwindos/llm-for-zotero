import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_LIMIT, makeContext, buildPrompt, buildUserMessage, noteHTML, noteMarkdown, SSEParser } from "../src/core.mjs";

test("translation can explicitly limit material without splitting Unicode", () => {
  const context = makeContext({ text: "a".repeat(CONTEXT_LIMIT - 1) + "🧠后文", limit: CONTEXT_LIMIT });
  assert.equal(context.truncated, true);
  assert.equal(context.text.length, CONTEXT_LIMIT - 1);
  assert.match(buildPrompt("总结", context), /非完整材料/);
});

test("chat materials keep long pasted text and math without a character cutoff", () => {
  const text = "a".repeat(180000) + "🧠 $\\sum_{i=1}^n x_i$ 末尾";
  const context = makeContext({ text });
  assert.equal(context.text, text); assert.equal(context.truncated, false);
  assert.ok(buildPrompt("解释", context).includes(text));
});

test("PDF prompts carry a separate file reference without converting its bytes to text", () => {
  const context = { type: "pdf", title: "Paper", filename: "equations.pdf", attachmentID: 24, size: 500000 };
  const message = buildUserMessage("解释公式", context);
  assert.deepEqual(message.pdf, context); assert.notEqual(message.pdf, context);
  assert.match(message.content, /PDF 原文件/); assert.ok(!message.content.includes("500000"));
  assert.equal(buildUserMessage("hello", null).pdf, undefined);
});
test("nothing is attached when context is absent or cleared", () => {
  assert.equal(buildPrompt(" hello ", null), "hello");
  assert.equal(buildPrompt("hello", { text: "" }), "hello");
  assert.throws(() => buildPrompt(" ", { text: "private text" }));
});
test("note escapes model output, titles, questions and malicious source URLs", () => {
  const html = noteHTML({ answer: '<img src=x onerror="alert(1)">', question: "<script>x</script>", context: { title: '<a href="x">', uri: "javascript:alert(1)", kind: "<script>" }, mode: "API" });
  assert.ok(!html.includes("<img")); assert.ok(!html.includes("<script>")); assert.ok(!html.includes("javascript:"));
  assert.match(html, /&lt;img/);
});
test("incomplete answer is marked in the saved note", () => {
  assert.match(noteHTML({ answer: "partial", partial: true, mode: "API" }), /未完成回答/);
});

test("Markdown export preserves formulas and image syntax without generating an HTML document", () => {
  const answer = "**结论**\n\n$$x_i^2$$\n\n![图](assets/image-test.png)";
  const md = noteMarkdown({ answer, question: "解释", source: { title: "Paper", uri: "zotero://select/library/items/PAPER" }, mode: "Gemini", date: "2026-10-15" });
  assert.ok(md.includes(answer)); assert.match(md, /^# LLM 阅读笔记/); assert.match(md, /zotero:\/\/select/); assert.ok(!md.includes("<html"));
});
test("SSE handles arbitrary chunk boundaries, CRLF, comments, and final data", () => {
  const events = [], parser = new SSEParser(e => events.push(e));
  const source = ':keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":"中文🧠"}\r\n\r\ndata: {"type":"response.completed"}';
  for (const char of source) parser.push(char);
  parser.push("", true);
  assert.deepEqual(events, [{ delta: "中文🧠" }, { type: "response.completed" }]);
});
test("SSE reports malformed events and ignores done sentinels", () => {
  const parser = new SSEParser(() => assert.fail("unexpected event"));
  parser.push("data: [DONE]\n\n");
  assert.throws(() => parser.push("data: bad json\n\n"), /解析/);
});
