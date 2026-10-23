import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStore } from "../src/history.mjs";

const entry = id => ({ id, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T01:00:00Z", apiKey: "fake-private-key",
  turns: [{ question: "解释目标", answer: "**结论** $x_0$", role: "Gemini", mode: "high", partial: false,
    material: { text: "paper text", title: "Paper", itemID: 12, apiKey: "fake-private-key" }, source: { itemID: 12, title: "Paper" } }] });

test("conversations survive a fresh store and serialize only chat fields", async () => {
  let text = null; const io = { read: async () => text, write: async value => { text = value; } };
  const store = new ConversationStore(io), snapshot = entry("one");
  const saving = store.save(snapshot); snapshot.turns[0].answer = "later mutation"; await saving;
  const restarted = new ConversationStore(io), saved = await restarted.get("one");
  assert.equal(saved.turns[0].answer, "**结论** $x_0$"); assert.equal(saved.turns[0].material.text, "paper text");
  assert.ok(!text.includes("fake-private-key")); assert.equal((await restarted.list())[0].title, "解释目标");
});

test("queued updates cannot lose another conversation and deletion persists", async () => {
  let text = null, fail = false;
  const io = { read: async () => text, write: async value => { if (fail) throw new Error("disk full"); text = value; } };
  const store = new ConversationStore(io);
  await Promise.all([store.save(entry("one")), store.save(entry("two"))]); assert.equal((await store.list()).length, 2);
  fail = true; await assert.rejects(store.delete("one"), /disk full/); assert.equal((await store.list()).length, 2);
  fail = false; await store.delete("one"); const restarted = new ConversationStore(io);
  assert.equal((await restarted.list()).length, 1); await assert.rejects(restarted.get("one"), /删除/);
  await restarted.delete("two"); assert.deepEqual(await new ConversationStore(io).list(), []);
});

test("a corrupt history file is preserved rather than replaced by an empty list", async () => {
  let writes = 0; const store = new ConversationStore({ read: async () => "broken json", write: async () => { writes++; } });
  await assert.rejects(store.save(entry("new")), /保留/); assert.equal(writes, 0);
  assert.throws(() => store.save({ ...entry("partial"), turns: [{ question: "q", answer: "partial", partial: true }] }), /未完成/);
});

test("PDF histories retain Zotero references, never file data, disk paths or credentials", async () => {
  let text = null; const io = { read: async () => text, write: async value => { text = value; } };
  const snapshot = entry("pdf");
  snapshot.turns[0].material = { type: "pdf", kind: "PDF 原文件", title: "Paper", itemID: 12, filename: "paper.pdf", size: 1200000, modifiedTime: 1760000000000,
    attachmentID: 24, attachmentKey: "PDFKEY01", attachmentLibraryID: 1, data: "private-file-bytes", path: "C:/private.pdf", key: "private-api-key" };
  await new ConversationStore(io).save(snapshot);
  const material = (await new ConversationStore(io).get("pdf")).turns[0].material;
  for (const name of ["type", "attachmentID", "attachmentKey", "attachmentLibraryID", "filename", "size", "modifiedTime"]) assert.equal(material[name], snapshot.turns[0].material[name]);
  for (const secret of ["private-file-bytes", "C:/private.pdf", "private-api-key"]) assert.ok(!text.includes(secret));
});

test("long text remains available after saving and reopening a conversation", async () => {
  let text = null; const io = { read: async () => text, write: async value => { text = value; } };
  const snapshot = entry("long"), material = "论文段落".repeat(40000) + "END $x_i$";
  snapshot.turns[0].material.text = material;
  await new ConversationStore(io).save(snapshot);
  assert.equal((await new ConversationStore(io).get("long")).turns[0].material.text, material);
});
