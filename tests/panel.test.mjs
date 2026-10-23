import test from "node:test";
import assert from "node:assert/strict";
import { runtime, flush, pause } from "./helpers.mjs";

test("daily UI has independent routes and a single composer, with vendor parameters only in model settings", t => {
  const { panel } = runtime(t);
  assert.equal(panel.root.getAttribute("aria-label"), "LLM for Zotero");
  assert.equal(panel.root.querySelectorAll('[aria-label="你的问题"]').length, 1);
  assert.equal(panel.root.querySelector("nav"), null);
  assert.equal(panel.compose.querySelectorAll("textarea").length, 1);
  assert.equal(panel.attachment.hidden, true); assert.equal(panel.addMenu.hidden, true); assert.equal(panel.materialPreview.hidden, true);
  assert.equal(panel.root.querySelector(".gptz-footer"), null);
  assert.equal(panel.models.root.hidden, true); panel.show(); assert.equal(panel.settings.hidden, true);
  panel.settingsButton.click(); assert.equal(panel.settings.hidden, false);
  assert.equal(panel.translationProfile.value, "deepseek"); assert.equal(panel.chatProfile.value, "gemini");
  for (const control of [panel.models.fast, panel.models.thinking, panel.models.geminiEffort]) assert.equal(control.closest('.gptz-model-settings'), panel.models.root);
  panel.openSettings(false); panel.show(false); panel.show(); assert.equal(panel.settings.hidden, true);
});

test("changing the translation route leaves the chat history and attached material intact", async t => {
  const { panel, host } = runtime(t); await panel.loadContext("selection", {});
  panel.messages = [{ role: "user", content: "history" }]; panel.question.value = "draft";
  host.setPref("translationProfileID", "openai");
  assert.equal(panel.translationProfile.value, "openai"); assert.equal(panel.messages.length, 1);
  host.setPref("chatProfileID", "deepseek");
  assert.equal(panel.messages.length, 0); assert.equal(panel.question.value, "draft"); assert.match(panel.prompt(), /source text/);
});

test("loading another paper clears history; clearing the source card removes it from the prompt", async t => {
  const { panel } = runtime(t); panel.messages = [{ role: "user", content: "old" }]; await panel.loadContext("abstract");
  assert.equal(panel.messages.length, 0); panel.question.value = "question"; assert.match(panel.prompt(), /source text/);
  panel.clearContext(); assert.equal(panel.prompt(), "question");
});

test("Gemini model settings save a separate key, fetch the catalog, and persist high without Fast", async t => {
  const { panel, host, requests, secrets } = runtime(t, { keys: false }); panel.openModelSettings();
  panel.models.key.value = "fake-google-secret"; const connecting = panel.models.connectProvider(); await flush();
  assert.equal(requests.length, 1); assert.match(requests[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(panel.models.key.value, ""); assert.equal(secrets.get("gemini"), "fake-google-secret");
  requests[0].load({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }] }); await connecting;
  panel.models.geminiEffort.value = "high"; panel.models.name.value = "My Gemini"; panel.models.saveProfile();
  const profile = host.taskProfile("chat"); assert.equal(profile.name, "My Gemini");
  assert.deepEqual(profile.options, { thinkingLevel: "high" }); assert.equal(host.getPref("geminiKey", null), null);
  assert.ok(!host.getPref("modelProfiles").includes("fake-google-secret"));
});

test("model catalog failure preserves the exact saved model and permits retry", async t => {
  const { panel, requests, host } = runtime(t); panel.openModelSettings(); await flush();
  requests[0].status = 503; requests[0].onload(); await flush();
  assert.equal(panel.models.model.value, "gemini-3.8-flash"); assert.equal(host.taskProfile("chat").model, "gemini-3.8-flash");
  const retry = panel.models.connectProvider(); await flush();
  requests[1].load({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }); await retry;
  assert.equal(panel.models.model.disabled, false);
});

test("closing or replacing the model editor during credential refresh cannot start a late catalog request", async t => {
  for (const action of [models => models.close(), models => models.edit("openai"), models => models.create()]) {
    const { panel, host, requests } = runtime(t); const waiting = [];
    host.credential = () => new Promise(resolve => waiting.push(resolve));
    panel.openModelSettings(); assert.equal(waiting.length, 1);
    await panel.models.connectProvider(); assert.equal(waiting.length, 1); // A double click shares the in-flight attempt.
    action(panel.models); waiting[0]("old-key"); await flush();
    assert.equal(requests.length, 0);
    if (waiting[1]) { waiting[1]("new-key"); await flush(); assert.equal(requests.length, 1); }
  }
});

test("switching manufacturer discards unsaved credential input", async t => {
  const { panel, dom } = runtime(t, { keys: false }); panel.openModelSettings();
  panel.models.key.value = "fake-gemini-secret"; panel.models.provider.value = "deepseek";
  panel.models.provider.dispatchEvent(new dom.window.Event("change"));
  assert.equal(panel.models.key.value, "");
});

test("switching editor manufacturer exposes only that manufacturer's parameters", async t => {
  const { panel, dom, requests } = runtime(t); panel.openModelSettings(); await flush();
  panel.models.provider.value = "deepseek"; panel.models.provider.dispatchEvent(new dom.window.Event("change")); await flush();
  assert.equal(panel.models.deepseekOptions.hidden, false); assert.equal(panel.models.geminiOptions.hidden, true); assert.equal(panel.models.openaiOptions.hidden, true);
  assert.equal(panel.models.thinking.checked, false); assert.equal(panel.models.deepseekEffort.disabled, true);
  assert.equal(requests[0].aborted, true); assert.match(requests.at(-1).url, /api\.deepseek\.com/);
});

test("ChatGPT stays available in model configuration with existing account and sign-out controls", async t => {
  const { panel, host, requests } = runtime(t); panel.models.open("chatgpt"); await flush();
  assert.equal(panel.models.keyLabel.hidden, true); assert.equal(panel.models.accountPane.hidden, false);
  assert.equal(panel.models.logout.hidden, false); assert.match(requests[0].url, /api\.openai\.com\/v1\/models$/);
  requests[0].load({ models: [{ slug: "gpt-test", display_name: "GPT test", visibility: "list" }] }); await flush();
  assert.equal(panel.models.model.value, "gpt-test"); assert.equal(panel.models.model.disabled, false);
  await host.auth.signOut(); assert.equal(panel.models.logout.hidden, true); assert.equal(panel.models.login.textContent, "Continue with ChatGPT");
});

test("Gemini chat uses the selected configuration, not the translation provider", async t => {
  const { panel, requests, host } = runtime(t); panel.question.value = "Only answer OK.";
  const sending = panel.send(); await flush();
  assert.equal(requests.length, 1); assert.match(requests[0].url, /gemini-3\.8-flash:streamGenerateContent/);
  assert.equal(requests[0].headers["x-goog-api-key"], "fake-gemini");
  assert.equal(JSON.parse(requests[0].body).generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  requests[0].push({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }); await sending;
  assert.equal(panel.messages.length, 2); assert.equal(panel.messages[1].content, "OK"); assert.equal(host.taskProfile("translation").provider, "deepseek");
});

test("sending moves a snapshot of paper material into the user message and clears the draft immediately", async t => {
  const { panel, host, requests } = runtime(t); await panel.loadContext("selection", {});
  panel.question.value = "翻译这段"; let credential;
  host.credential = () => new Promise(resolve => { credential = resolve; });
  const sending = panel.send();
  const card = panel.transcript.querySelector(".gptz-user .gptz-sent-material");
  assert.ok(card); assert.equal(card.open, false); assert.match(card.querySelector("summary").textContent, /Paper/);
  assert.equal(card.querySelector(".gptz-source-text").textContent, "source text");
  assert.equal(panel.question.value, ""); assert.equal(panel.preview.textContent, ""); assert.equal(panel.context, null);
  assert.equal(panel.attachment.hidden, true);
  await flush(); credential("fake"); await flush();
  assert.match(JSON.parse(requests[0].body).contents[0].parts[0].text, /source text/);
  requests[0].push({ candidates: [{ content: { parts: [{ text: "译文" }] }, finishReason: "STOP" }] }); await sending;
  assert.equal(panel.chatContext.itemID, 12); assert.equal(panel.messages.length, 2);
  assert.equal(card.querySelector(".gptz-source-text").textContent, "source text");

  host.credential = async () => "fake"; panel.question.value = "为什么？";
  const followup = panel.send(); await flush();
  const input = JSON.parse(requests[1].body).contents;
  assert.equal(input[2].parts[0].text, "为什么？");
  assert.equal(input.filter(m => m.parts[0].text.includes("source text")).length, 1);
  requests[1].push({ candidates: [{ content: { parts: [{ text: "解释" }] }, finishReason: "STOP" }] }); await followup;
  let saved;
  host.saveNote = async record => { saved = record; return 1; };
  const buttons = [...panel.transcript.lastElementChild.querySelectorAll("button")];
  buttons.find(button => button.textContent === "导出笔记").click(); await flush(); await panel.exportRecord();
  assert.equal(saved.context.itemID, 12);
  host.context = async () => ({ title: "Other paper", kind: "摘要", text: "new source", itemID: 13 });
  await panel.loadContext("abstract"); assert.equal(panel.messages.length, 0);
});

test("failed and cancelled sends restore the question and attached paper without adding them to API history", async t => {
  for (const cancel of [true, false]) {
    const { panel, requests } = runtime(t); await panel.loadContext("selection", {}); panel.question.value = "question";
    const sending = panel.send(); await flush();
    assert.equal(panel.question.value, ""); assert.equal(panel.preview.textContent, "");
    if (cancel) panel.stopButton.click(); else { requests[0].status = 503; requests[0].onload(); }
    await sending;
    assert.equal(panel.question.value, "question"); assert.equal(panel.preview.textContent, "source text");
    assert.equal(panel.context.itemID, 12); assert.equal(panel.messages.length, 0); assert.equal(panel.busy, false);
    assert.deepEqual(await hostHistory(panel), []);
  }
});

const hostHistory = panel => panel.host.history().list();

test("completed conversations restore context and continue without duplicating their history entry", async t => {
  const { panel, requests } = runtime(t); await panel.loadContext("selection", {}); panel.question.value = "解释";
  const sending = panel.send(); await flush();
  requests[0].push({ candidates: [{ content: { parts: [{ text: "**目标** $x_0$" }] }, finishReason: "STOP" }] }); await sending;
  const [entry] = await hostHistory(panel); assert.ok(entry.id);
  panel.resetChat(); await panel.openHistory(); assert.equal(panel.historyList.querySelectorAll(".gptz-history-item").length, 1);
  await panel.restoreConversation(entry.id); assert.equal(panel.messages.length, 2); assert.equal(panel.chatContext.itemID, 12);
  assert.ok(panel.transcript.querySelector(".katex")); assert.equal(panel.historyView.hidden, true);
  panel.question.value = "为什么？"; const next = panel.send(); await flush();
  assert.equal(JSON.parse(requests[1].body).contents.length, 3);
  requests[1].push({ candidates: [{ content: { parts: [{ text: "因为目标" }] }, finishReason: "STOP" }] }); await next;
  assert.equal((await hostHistory(panel)).length, 1); assert.equal((await panel.host.history().get(entry.id)).turns.length, 2);
  await panel.openHistory(); const row = panel.historyList.firstElementChild;
  [...row.querySelectorAll("button")].find(b => b.textContent === "删除").click();
  assert.equal([...row.querySelectorAll("button")].find(b => b.textContent === "确认删除").hidden, false);
  await panel.deleteConversation(entry.id); assert.deepEqual(await hostHistory(panel), []); assert.equal(panel.messages.length, 0);
});

test("history write failures do not turn a completed answer into a failed request or restore its draft", async t => {
  const { panel, requests, host } = runtime(t); host.history = () => ({ save: async () => { throw new Error("disk full"); } });
  panel.question.value = "Explain"; const sending = panel.send(); await flush();
  requests[0].push({ candidates: [{ content: { parts: [{ text: "Completed answer" }] }, finishReason: "STOP" }] }); await sending;
  assert.equal(panel.messages.length, 2); assert.equal(panel.question.value, ""); assert.match(panel.statusBox.textContent, /历史保存失败/);
});

test("a final render failure preserves the raw answer, actions and completed history", async t => {
  const { panel, requests, host, dom } = runtime(t); let copied, exported;
  host.copy = text => { copied = text; };
  host.saveNote = async record => { exported = record; return 91; };
  panel.question.value = "Explain"; const sending = panel.send(); await flush();
  const answer = '**完成**\n<script>alert(1)</script>\n$x_i$';
  panel.purify.sanitize = () => { throw new dom.window.DOMException("An invalid or illegal string was specified", "SyntaxError"); };
  requests[0].push({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }] });
  await assert.doesNotReject(sending);
  const body = panel.transcript.lastElementChild.querySelector(".gptz-answer");
  assert.equal(body.textContent, answer); assert.equal(body.querySelector("script"), null);
  assert.equal(body.style.whiteSpace, "pre-wrap");
  assert.equal(panel.busy, false); assert.equal(panel.pending, null); assert.equal(panel.question.value, "");
  assert.equal(panel.messages[1].content, answer); assert.equal((await hostHistory(panel)).length, 1);
  assert.equal((await host.history().get(panel.historyID)).turns[0].answer, answer);
  const buttons = [...panel.transcript.lastElementChild.querySelectorAll("button")];
  buttons.find(button => button.textContent === "复制").click(); assert.equal(copied, answer);
  buttons.find(button => button.textContent === "导出笔记").click(); await flush();
  assert.ok(panel.noteEditor.value.includes(answer)); assert.equal(await panel.exportRecord(), 91); assert.equal(exported.answer, answer);
});

test("scheduled rendering failures keep streaming text visible and allow generation to finish", async t => {
  const { panel, requests, dom } = runtime(t); let paint;
  const schedule = panel.window.setTimeout.bind(panel.window);
  panel.window.setTimeout = (callback, delay, ...args) => delay === 50 ? (paint = callback, -1) : schedule(callback, delay, ...args);
  panel.question.value = "Explain"; const sending = panel.send(); await flush();
  const sanitize = panel.purify.sanitize;
  panel.purify.sanitize = () => { throw new dom.window.DOMException("An invalid or illegal string was specified", "SyntaxError"); };
  requests[0].push({ candidates: [{ content: { parts: [{ text: "第一行\n第二行" }] } }] });
  assert.equal(typeof paint, "function"); assert.doesNotThrow(() => paint());
  const body = panel.transcript.lastElementChild.querySelector(".gptz-answer");
  assert.equal(body.textContent, "第一行\n第二行"); assert.equal(panel.busy, true);
  panel.purify.sanitize = sanitize;
  requests[0].push({ candidates: [{ content: { parts: [{ text: "\n\n**完成**" }] }, finishReason: "STOP" }] }); await sending;
  assert.ok(body.querySelector("strong")); assert.equal(body.style.whiteSpace, "");
  assert.equal(panel.messages[1].content, "第一行\n第二行\n\n**完成**"); assert.equal((await hostHistory(panel)).length, 1);
});

test("a render failure during a network interruption retains the partial answer and restores its draft", async t => {
  const { panel, requests, dom } = runtime(t); await panel.loadContext("selection", {});
  panel.question.value = "Explain"; const sending = panel.send(); await flush();
  panel.purify.sanitize = () => { throw new dom.window.DOMException("An invalid or illegal string was specified", "SyntaxError"); };
  requests[0].push({ candidates: [{ content: { parts: [{ text: "已收到的部分回答" }] } }] }); requests[0].onerror();
  await assert.doesNotReject(sending);
  const article = panel.transcript.lastElementChild;
  assert.equal(article.querySelector(".gptz-answer").textContent, "已收到的部分回答"); assert.match(article.textContent, /未完成回答/);
  assert.equal(article.querySelectorAll("button").length, 2); assert.equal(panel.question.value, "Explain");
  assert.equal(panel.context.itemID, 12); assert.equal(panel.messages.length, 0); assert.equal(panel.busy, false);
  assert.deepEqual(await hostHistory(panel), []);
});

test("Markdown export supports local image insertion and keeps the edited draft after a failed export", async t => {
  const { panel, host } = runtime(t); let saved;
  host.pickImage = async () => ({ path: "/picked/figure.png", name: "image-test.png", label: "图.png" });
  await panel.saveRecord({ question: "Explain", answer: "**目标** $x_0$", mode: "Gemini", source: { itemID: 12, title: "Paper" } });
  assert.equal(panel.noteView.hidden, false); assert.equal(panel.chatView.hidden, true); assert.ok(panel.noteEditor.value.includes("$x_0$"));
  const end = panel.noteEditor.value.length; panel.noteEditor.setSelectionRange(end, end); await panel.insertNoteImage();
  assert.ok(panel.noteEditor.value.includes("![图.png](assets/image-test.png)"));
  host.saveNote = async () => { throw new Error("disk full"); }; await assert.rejects(panel.exportRecord(), /disk full/);
  assert.equal(panel.noteView.hidden, false); assert.equal(panel.noteImages.length, 1);
  host.saveNote = async (record, markdown, images) => { saved = { record, markdown, images }; return 88; };
  assert.equal(await panel.exportRecord(), 88); assert.equal(saved.record.source.itemID, 12); assert.equal(saved.images.length, 1);
  assert.ok(saved.markdown.includes("assets/image-test.png")); assert.equal(panel.noteView.hidden, true);
});

test("the plus menu pastes a paper attachment while retaining one question input", async t => {
  const { panel, requests, host } = runtime(t); host.paste = () => "A directly pasted paper paragraph."; panel.question.value = "解释";
  panel.addButton.click(); panel.addMenu.querySelector('[data-context-kind="paste"]').click(); await flush();
  assert.equal(panel.addMenu.hidden, true); assert.equal(panel.attachment.hidden, false);
  assert.equal(panel.materialPreview.hidden, true); assert.equal(panel.question.value, "解释");
  assert.equal(panel.compose.querySelectorAll("textarea").length, 1);
  const sending = panel.send(); await flush();
  assert.match(JSON.parse(requests[0].body).contents[0].parts[0].text, /directly pasted/);
  assert.match(panel.transcript.querySelector(".gptz-source-text").textContent, /directly pasted/);
  assert.equal(panel.preview.textContent, "");
  requests[0].push({ candidates: [{ content: { parts: [{ text: "解释结果" }] }, finishReason: "STOP" }] }); await sending;
});

test("the attachment opens an on-demand original-text preview and can be removed without changing the question", async t => {
  const { panel, host } = runtime(t); host.paste = () => '<img src=x onerror="alert(1)">original';
  panel.question.value = "draft"; await panel.pasteContext();
  panel.contextButton.click(); assert.equal(panel.materialPreview.hidden, false);
  assert.equal(panel.preview.querySelector("img"), null); assert.match(panel.preview.textContent, /original/);
  assert.equal(panel.contextButton.getAttribute("aria-expanded"), "true");
  panel.previewClose.click(); assert.equal(panel.materialPreview.hidden, true);
  panel.compose.querySelector('[aria-label="移除论文材料"]').click();
  assert.equal(panel.attachment.hidden, true); assert.equal(panel.question.value, "draft"); assert.equal(panel.prompt(), "draft");
});

test("the add menu supports keyboard navigation and closes outside the composer", t => {
  const { panel, dom } = runtime(t); const buttons = [...panel.addMenu.querySelectorAll("button")];
  panel.addButton.click(); assert.equal(panel.addMenu.hidden, false); assert.equal(dom.window.document.activeElement, buttons[0]);
  panel.addMenu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(dom.window.document.activeElement, buttons[1]);
  panel.addMenu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(panel.addMenu.hidden, true); assert.equal(dom.window.document.activeElement, panel.question);
  panel.addButton.click(); dom.window.document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(panel.addMenu.hidden, true); assert.equal(panel.addButton.getAttribute("aria-expanded"), "false");
});

test("the single composer grows with text and returns to a compact height when cleared", t => {
  const { panel, dom } = runtime(t);
  Object.defineProperty(panel.question, "scrollHeight", { get: () => panel.question.value ? 260 : 32 });
  panel.question.value = "long message"; panel.question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(panel.question.style.height, "180px"); assert.equal(panel.question.style.overflowY, "auto");
  panel.question.value = ""; panel.question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(panel.question.style.height, "48px"); assert.equal(panel.question.style.overflowY, "hidden");
});

test("streaming renders Markdown and math, follows a new send and respects scrolling up", async t => {
  const { panel, requests, dom } = runtime(t); const transcript = panel.transcript;
  let scrollTop = 0;
  Object.defineProperties(transcript, {
    clientHeight: { get: () => 200 },
    scrollHeight: { get: () => 2000 + transcript.textContent.length },
    scrollTop: { get: () => scrollTop, set: value => { scrollTop = Math.min(value, transcript.scrollHeight - 200); } }
  });
  panel.question.value = "解释公式"; const sending = panel.send(); await flush();
  assert.equal(scrollTop, transcript.scrollHeight - 200);
  requests[0].push({ candidates: [{ content: { parts: [{ text: "**目标** $x_i^2$" }] } }] }); await pause(80);
  const answer = transcript.lastElementChild.querySelector(".gptz-answer");
  assert.ok(answer.querySelector("strong")); assert.ok(answer.querySelector(".katex"));
  assert.equal(panel.busy, true); assert.equal(scrollTop, transcript.scrollHeight - 200);
  scrollTop = 0; transcript.dispatchEvent(new dom.window.Event("scroll"));
  requests[0].push({ candidates: [{ content: { parts: [{ text: "\n\n- 条件一\n- 条件二" }] } }] }); await pause(80);
  assert.ok(answer.querySelector("li")); assert.equal(scrollTop, 0);
  requests[0].push({ candidates: [{ finishReason: "STOP" }] }); await sending;
  assert.equal(scrollTop, 0); assert.ok(answer.querySelector(".katex"));
});

test("temporary formula reflow cannot resume following after the reader scrolls up", async t => {
  const { panel, requests, dom } = runtime(t), transcript = panel.transcript;
  let height = 800, top = 0;
  Object.defineProperties(transcript, {
    clientHeight: { get: () => 200 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: value => { top = Math.min(value, height - 200); } }
  });
  panel.question.value = "Explain the formula"; const sending = panel.send(); await flush();
  top = 0;
  // The native scroll event may arrive after a math reflow shortens the answer.
  height = 250; transcript.dispatchEvent(new dom.window.Event("scroll"));
  requests[0].push({ candidates: [{ content: { parts: [{ text: "The estimate is $x_0$." }] } }] }); await pause(80);
  assert.equal(top, 0);
  // Following resumes when the reader explicitly scrolls back down.
  top = 50; transcript.dispatchEvent(new dom.window.Event("scroll")); height = 600;
  requests[0].push({ candidates: [{ content: { parts: [{ text: "\n\nMore explanation." }] } }] }); await pause(80);
  assert.equal(top, 400);
  requests[0].push({ candidates: [{ finishReason: "STOP" }] }); await sending;
});

test("stopping during credential acquisition prevents a late paid generation request", async t => {
  const { panel, host, requests } = runtime(t); let finish;
  host.credential = () => new Promise(resolve => { finish = resolve; }); panel.question.value = "Question";
  const sending = panel.send(); await flush(); panel.stopButton.click(); finish("fake"); await sending;
  assert.equal(requests.length, 0); assert.equal(panel.messages.length, 0); assert.equal(panel.busy, false);
});

test("configuration changes during a stream cancel it and cannot add an old answer to new history", async t => {
  const { panel, host, requests } = runtime(t); panel.question.value = "question"; const sending = panel.send(); await flush();
  requests[0].push({ candidates: [{ content: { parts: [{ text: "partial" }] } }] });
  host.setPref("chatProfileID", "deepseek"); await sending;
  assert.equal(requests[0].aborted, true); assert.equal(panel.messages.length, 0); assert.equal(panel.chatProfile.value, "deepseek");
});

test("untrusted answer HTML cannot load external resources, scripts or event handlers", t => {
  const { panel } = runtime(t), node = panel.el("div");
  panel.renderMarkdown(node, '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src=x></iframe><a href="javascript:alert(1)" onclick="alert(1)">x</a><p style="color:red">ok</p>');
  assert.equal(node.querySelector("script, img, iframe, [onclick], [style]"), null); assert.ok(!node.innerHTML.includes("javascript:"));
});

test("Enter sends once; Shift+Enter and IME composition preserve editing", t => {
  const { panel, dom } = runtime(t); let sends = 0; panel.send = () => { sends++; };
  for (const args of [{ shiftKey: true }, { isComposing: true }, {}]) panel.question.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ...args }));
  assert.equal(sends, 1);
});

function attachPDF(host) {
  const bytes = Buffer.from("%PDF-1.7\noriginal formula bytes\n%%EOF");
  const context = { type: "pdf", kind: "PDF 原文件", title: "Paper with equations", itemID: 12, filename: "equations.pdf", size: bytes.length,
    attachmentID: 24, attachmentKey: "PDFKEY01", attachmentLibraryID: 1, modifiedTime: 1760000000000 };
  host.context = async () => ({ ...context });
  const prepared = [];
  host.prepareMessages = async messages => {
    prepared.push(messages);
    return messages.map(m => ({ role: m.role, content: m.content, ...(m.pdf ? { pdf: { filename: m.pdf.filename, mimeType: "application/pdf", size: bytes.length, data: bytes.toString("base64") } } : {}) }));
  };
  return { context, bytes, prepared };
}
const finishGemini = (request, text = "公式解释") => request.push({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });

test("PDF card sends original bytes and survives follow-up and saved-history restoration", async t => {
  const { panel, host, requests } = runtime(t), { context, bytes, prepared } = attachPDF(host);
  await panel.loadContext("pdf"); panel.question.value = "解释公式";
  assert.equal(panel.attachment.hidden, false); assert.match(panel.contextInfo.textContent, /PDF 原文件/);
  panel.contextButton.click(); assert.match(panel.preview.textContent, /equations.pdf/);
  const sending = panel.send(); await flush();
  assert.equal(panel.context, null); assert.equal(panel.question.value, ""); assert.equal(panel.attachment.hidden, true);
  assert.equal(panel.transcript.querySelectorAll(".gptz-sent-pdf").length, 1);
  const payload = JSON.parse(requests[0].body), part = payload.contents[0].parts.find(p => p.inlineData);
  assert.deepEqual(Buffer.from(part.inlineData.data, "base64"), bytes);
  assert.ok(!panel.transcript.textContent.includes(part.inlineData.data));
  finishGemini(requests[0]); await sending;
  assert.equal(panel.messages[0].pdf.attachmentID, context.attachmentID); assert.equal(panel.messages[0].pdf.data, undefined);
  const id = panel.historyID; panel.resetChat(); await panel.restoreConversation(id);
  assert.equal(panel.transcript.querySelectorAll(".gptz-sent-pdf").length, 1);
  panel.question.value = "继续"; const next = panel.send(); await flush();
  const again = JSON.parse(requests[1].body);
  assert.deepEqual(again.contents[0].parts.find(p => p.inlineData), part);
  assert.equal(prepared[1][0].pdf.attachmentID, context.attachmentID);
  finishGemini(requests[1]); await next;
  assert.equal((await host.history().list()).length, 1);
});

test("removing a PDF card removes it from a new request without touching the question", async t => {
  const { panel, host, requests } = runtime(t); attachPDF(host);
  await panel.loadContext("pdf"); panel.question.value = "hello"; panel.clearContext();
  assert.equal(panel.attachment.hidden, true); assert.equal(panel.prompt(), "hello");
  const sending = panel.send(); await flush();
  assert.ok(!JSON.stringify(JSON.parse(requests[0].body).contents).includes("inlineData"));
  finishGemini(requests[0]); await sending;
});

test("unsupported PDF providers keep the draft and avoid network or credential access", async t => {
  const { panel, host, requests } = runtime(t); const { context } = attachPDF(host);
  host.setPref("chatProfileID", "deepseek"); await panel.loadContext("pdf"); panel.question.value = "解释";
  host.credential = () => assert.fail("unsupported PDFs must fail before credentials");
  await assert.rejects(panel.send(), /DeepSeek.*PDF/);
  assert.equal(requests.length, 0); assert.equal(panel.question.value, "解释"); assert.equal(panel.context.attachmentID, context.attachmentID);
  assert.equal(panel.transcript.querySelectorAll(".gptz-message").length, 0);
});

test("missing PDFs and cancellation while reading preserve drafts without a late request", async t => {
  for (const cancelled of [false, true]) {
    const { panel, host, requests } = runtime(t); attachPDF(host); await panel.loadContext("pdf"); panel.question.value = "解释";
    let finish;
    host.prepareMessages = cancelled ? () => new Promise(resolve => { finish = resolve; }) : async () => { throw new Error("PDF 原文件不存在"); };
    const sending = panel.send(); await flush();
    if (cancelled) { panel.stopButton.click(); finish([]); }
    await sending;
    assert.equal(requests.length, 0); assert.equal(panel.messages.length, 0); assert.equal(panel.question.value, "解释");
    assert.equal(panel.context.type, "pdf"); assert.equal(panel.busy, false);
  }
});

test("a pending PDF cannot be silently overwritten by opening history", async t => {
  const { panel, host } = runtime(t); attachPDF(host); await panel.loadContext("pdf");
  await assert.rejects(panel.restoreConversation("any"), /先发送或清空/);
  assert.equal(panel.context.type, "pdf");
});

test("long pasted material reaches the provider and saved history without truncation", async t => {
  const { panel, host, requests } = runtime(t), text = "论文正文".repeat(40000) + "末尾 $x_i$";
  host.paste = () => text; await panel.pasteContext(); panel.question.value = "解释";
  assert.equal(panel.context.text, text); assert.equal(panel.context.truncated, false);
  const sending = panel.send(); await flush();
  assert.ok(JSON.parse(requests[0].body).contents[0].parts[0].text.includes(text));
  finishGemini(requests[0]); await sending;
  assert.equal((await host.history().get(panel.historyID)).turns[0].material.text, text);
});

test("reattaching a modified PDF starts a fresh conversation and keeps the earlier history", async t => {
  const { panel, host, requests } = runtime(t); const { context } = attachPDF(host);
  await panel.loadContext("pdf"); panel.question.value = "解释";
  const sending = panel.send(); await flush(); finishGemini(requests[0]); await sending;
  host.context = async () => ({ ...context, modifiedTime: context.modifiedTime + 1000 });
  panel.question.value = "新的问题"; await panel.loadContext("pdf");
  assert.equal(panel.messages.length, 0); assert.equal(panel.question.value, "新的问题");
  assert.equal((await host.history().list()).length, 1); assert.match(panel.statusBox.textContent, /已开始新对话/);
});
