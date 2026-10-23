import test from "node:test";
import assert from "node:assert/strict";
import { ZoteroHost } from "../src/zotero.mjs";

test("provider key stores stay separate and unknown providers cannot reuse an OpenAI credential", async () => {
  const records = [];
  globalThis.Services = { logins: {
    findLogins: (origin, form, realm) => records.filter(r => r.origin === origin && r.realm === realm),
    addLoginAsync: async login => { records.push(login); },
    modifyLogin: (old, login) => { records[records.indexOf(old)] = login; },
    removeLogin: login => { records.splice(records.indexOf(login), 1); }
  } };
  globalThis.Ci = { nsILoginInfo: {} };
  globalThis.Cc = { "@mozilla.org/login-manager/loginInfo;1": { createInstance: () => ({
    init(origin, form, realm, username, password) { Object.assign(this, { origin, realm, username, password }); }
  }) } };
  const host = new ZoteroHost({}), prefs = new Map();
  host.getPref = (name, fallback) => prefs.get(name) ?? fallback; host.setPref = (name, value) => prefs.set(name, value);
  for (const provider of ["openai", "deepseek", "gemini"]) await host.setKey(`fake-${provider}`, provider);
  for (const provider of ["openai", "deepseek", "gemini"]) assert.equal(await host.credential(provider), `fake-${provider}`);
  assert.equal(host.getKey("api"), "fake-openai");
  await host.setKey("new-fake-deepseek", "deepseek"); assert.equal(host.getKey("gemini"), "fake-gemini");
  await host.setKey("", "gemini"); assert.equal(host.getKey("gemini"), ""); assert.equal(records.length, 2);
  await assert.rejects(host.credential("unknown"), /不支持/);
  await assert.rejects(host.setKey("fake", "unknown"), /不支持/);
});

function exportRuntime() {
  const operations = [], parent = { id: 123, libraryID: 7, isRegularItem: () => true, getField: () => "Source" };
  const library = { editable: true, filesEditable: true };
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.IOUtils = {
    writeUTF8: async (path, body) => operations.push({ type: "write", path, body }),
    remove: async (path, options) => operations.push({ type: "remove", path, options }),
    makeDirectory: async path => operations.push({ type: "mkdir", path }),
    copy: async (from, to) => operations.push({ type: "copy", from, to })
  };
  globalThis.Zotero = {
    Items: { getAsync: async () => parent }, Libraries: { get: () => library },
    DB: { executeTransaction: () => assert.fail("must not nest the import API's transaction") }, getTempDirectory: () => ({ path: "/tmp" }), getStorageDirectory: () => ({ path: "/storage" }),
    Notifier: { Queue: class {}, commit: async () => operations.push({ type: "notify" }) },
    Attachments: { importFromFile: async options => { operations.push({ type: "import", options }); return { id: 88, key: "NEWFILE", eraseTx: async () => operations.push({ type: "erase", id: 88 }) }; }, getStorageDirectory: () => ({ path: "/storage/NEWFILE" }) }
  };
  const host = new ZoteroHost({ crypto: { randomUUID: () => "test-id" } }); host.selectedItem = async () => ({ item: { ...parent, id: 999 } });
  return { host, operations, parent, library };
}

test("Markdown is an imported child attachment of the captured source, with its local image assets", async () => {
  const { host, operations } = exportRuntime();
  const record = { question: "Explain", answer: "**answer** $x_0$", mode: "Gemini", context: { itemID: 123, title: "Source", kind: "摘要" } };
  const id = await host.saveNote(record, "# 笔记\n![图](assets/image-test.png)", [{ path: "/picked/figure.png", name: "image-test.png" }, { path: "/unused.png", name: "image-unused.png" }]);
  assert.equal(id, 88); const imported = operations.find(o => o.type === "import").options;
  assert.equal(imported.parentItemID, 123); assert.equal(imported.contentType, "text/markdown"); assert.ok(imported.file.endsWith(".md"));
  assert.deepEqual(operations.filter(o => o.type === "copy"), [{ type: "copy", from: "/picked/figure.png", to: "/storage/NEWFILE/assets/image-test.png" }]);
  assert.ok(operations.findIndex(o => o.type === "notify") > operations.findIndex(o => o.type === "copy"));
  assert.ok(operations.some(o => o.type === "remove" && o.path === "/tmp/llm-note-test-id.md"));
});

test("read-only, missing and non-regular sources cannot redirect exported notes elsewhere", async () => {
  const { host, operations, library, parent } = exportRuntime();
  library.editable = false; await assert.rejects(host.saveNote({ answer: "a", context: { itemID: 123 } }), /只读/);
  library.editable = true; library.filesEditable = false; await assert.rejects(host.saveNote({ answer: "a", source: { itemID: 123 } }), /只读/);
  Zotero.Items.getAsync = async () => null; await assert.rejects(host.saveNote({ answer: "a", context: { itemID: 123 } }), /删除/);
  Zotero.Items.getAsync = async () => ({ ...parent, isRegularItem: () => false }); await assert.rejects(host.saveNote({ answer: "a", context: { itemID: 123 } }), /文献/);
  assert.equal(operations.length, 0);
});

test("image copy failure erases only the newly imported attachment and leaves the note draft retryable", async () => {
  const { host, operations } = exportRuntime(); IOUtils.copy = async () => { throw new Error("copy failed"); };
  await assert.rejects(host.saveNote({ answer: "a", source: { itemID: 123 } }, "![图](assets/image-test.png)", [{ path: "/picked.png", name: "image-test.png" }]), /copy failed/);
  assert.deepEqual(operations.filter(o => o.type === "erase"), [{ type: "erase", id: 88 }]);
  assert.ok(!operations.some(o => o.type === "notify"));
  assert.ok(operations.some(o => o.type === "remove" && o.path.startsWith("/tmp/")));
});
