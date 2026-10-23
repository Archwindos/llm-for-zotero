import test from "node:test";
import assert from "node:assert/strict";
import { ZoteroHost } from "../src/zotero.mjs";
import { pdfBase64, validatePDFMessages, PDF_BYTES_LIMIT } from "../src/pdf.mjs";
import { assertPDFSupport, streamModel } from "../src/providers.mjs";
import { JSDOM } from "jsdom";

function runtime() {
  const bytes = new Uint8Array(100_007); bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  for (let i = 9; i < bytes.length; i++) bytes[i] = i % 256;
  const attachment = { id: 4, key: "PDFKEY", libraryID: 1, attachmentFilename: "paper.pdf", attachmentContentType: "application/pdf",
    isAttachment: () => true, getFilePathAsync: async () => "/paper.pdf" };
  const parent = { id: 2, key: "PAPER", libraryID: 1, getField: () => "Full paper", isRegularItem: () => true, getBestAttachment: async () => attachment };
  const stat = { type: "regular", size: bytes.length, lastModified: 123456 };
  let exists = true;
  const reads = [];
  globalThis.IOUtils = { exists: async () => exists, stat: async () => ({ ...stat }), read: async (path, options) => { reads.push(options); return bytes.slice(0, options.maxBytes); } };
  globalThis.Zotero = { Items: { getAsync: async id => id === 4 ? attachment : parent }, Libraries: { get: () => ({ libraryType: "user" }) },
    FullText: new Proxy({}, { get() { assert.fail("PDF must never access text indexing"); } }) };
  const host = new ZoteroHost({}); host.selectedItem = async () => ({ item: parent, attachment: null });
  return { host, attachment, stat, bytes, reads, setMissing() { exists = false; } };
}

test("PDF capture is metadata only and sends original binary bytes without text indexing or truncation", async () => {
  const r = runtime(), ref = await r.host.context("pdf");
  assert.deepEqual(ref, { itemID: 2, libraryID: 1, itemKey: "PAPER", title: "Full paper", uri: "zotero://select/library/items/PAPER",
    type: "pdf", kind: "PDF 原文件", attachmentID: 4, attachmentKey: "PDFKEY", attachmentLibraryID: 1,
    filename: "paper.pdf", size: r.bytes.length, modifiedTime: 123456 });
  assert.deepEqual(r.reads, [{ maxBytes: 5 }]);
  const messages = [{ role: "user", content: "read the whole paper", pdf: ref }], before = JSON.stringify(messages);
  const prepared = await r.host.prepareMessages(messages);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(new Uint8Array(Buffer.from(prepared[0].pdf.data, "base64")), r.bytes);
  assert.equal(prepared[0].content, messages[0].content); assert.equal(validatePDFMessages(prepared), true);
  assert.equal(prepared[0].pdf.attachmentID, undefined);
});

test("all historical PDF refs are re-resolved each send and same PDF is included once per request", async () => {
  const r = runtime(), ref = await r.host.context("pdf");
  const messages = [{ role: "user", content: "first", pdf: ref }, { role: "assistant", content: "answer" }, { role: "user", content: "follow up", pdf: { ...ref } }];
  const first = await r.host.prepareMessages(messages), second = await r.host.prepareMessages(messages);
  assert.equal(first.filter(m => m.pdf).length, 1); assert.equal(second.filter(m => m.pdf).length, 1);
  assert.equal(second[0].pdf.data, first[0].pdf.data); assert.deepEqual(second.slice(1), [{ role: "assistant", content: "answer" }, { role: "user", content: "follow up" }]);
  assert.equal(r.reads.filter(o => o.maxBytes === r.bytes.length + 1).length, 2);
  r.setMissing(); await assert.rejects(r.host.prepareMessages(messages), /不存在|下载/);
});

test("missing, deleted, replaced, wrong-library, wrong-key and non-PDF attachments fail closed", async () => {
  for (const change of [r => r.setMissing(), r => { r.attachment.deleted = true; }, r => { r.stat.size++; }, r => { r.stat.lastModified++; },
    r => { r.attachment.libraryID++; }, r => { r.attachment.key = "OTHER"; }, r => { r.attachment.attachmentContentType = "text/plain"; }, r => { r.bytes[0] = 0; }]) {
    const r = runtime(), ref = await r.host.context("pdf"); change(r);
    await assert.rejects(r.host.prepareMessages([{ role: "user", content: "q", pdf: ref }]), /PDF/);
  }
});

test("PDF total size is bounded before reading full bytes, counting each unique attachment once", async () => {
  const r = runtime(), ref = await r.host.context("pdf");
  r.stat.size = PDF_BYTES_LIMIT; ref.size = PDF_BYTES_LIMIT;
  await assert.rejects(r.host.prepareMessages([{ role: "user", content: "q", pdf: ref }]), /50 MB/);
  assert.ok(r.reads.every(o => o.maxBytes === 5));
});

test("two different PDFs exceeding the combined limit fail before the second full read", async () => {
  const r = runtime(), ref = await r.host.context("pdf"), second = { ...r.attachment, id: 5, key: "SECOND" };
  const secondRef = { ...ref, attachmentID: 5, attachmentKey: "SECOND", size: PDF_BYTES_LIMIT - r.bytes.length };
  Zotero.Items.getAsync = async id => id === 4 ? r.attachment : second;
  let secondFile = false;
  second.getFilePathAsync = async () => { secondFile = true; return "/second.pdf"; };
  const stat = IOUtils.stat; IOUtils.stat = async path => path === "/second.pdf" ? { ...r.stat, size: secondRef.size } : stat(path);
  await assert.rejects(r.host.prepareMessages([{ role: "user", content: "one", pdf: ref }, { role: "user", content: "two", pdf: secondRef }]), /50 MB/);
  assert.equal(secondFile, true); assert.equal(r.reads.filter(o => o.maxBytes > 5).length, 1);
});

test("browser FileReader encodes binary bytes asynchronously and observes cancellation", async () => {
  const r = runtime(), dom = new JSDOM("");
  try {
    assert.deepEqual(new Uint8Array(Buffer.from(await pdfBase64(dom.window, r.bytes), "base64")), r.bytes);
    let checks = 0;
    await assert.rejects(pdfBase64(dom.window, r.bytes, () => ++checks > 1), { name: "AbortError" });
  } finally { dom.window.close(); }
});

test("cancellation during reads or asynchronous encoding prevents prepared payload delivery", async () => {
  const r = runtime(), ref = await r.host.context("pdf"); let cancelled = false;
  const read = IOUtils.read;
  IOUtils.read = async (path, options) => { const result = await read(path, options); if (options.maxBytes > 5) cancelled = true; return result; };
  await assert.rejects(r.host.prepareMessages([{ role: "user", content: "q", pdf: ref }], { isCancelled: () => cancelled }), { name: "AbortError" });
  cancelled = false;
  await assert.rejects(pdfBase64({ setTimeout: resolve => { cancelled = true; setTimeout(resolve, 0); } }, r.bytes, () => cancelled), { name: "AbortError" });
});

test("a file that changes while being read is rejected", async () => {
  const r = runtime(), ref = await r.host.context("pdf"), read = IOUtils.read;
  IOUtils.read = async (path, options) => { const result = await read(path, options); if (options.maxBytes > 5) r.stat.lastModified++; return result; };
  await assert.rejects(r.host.prepareMessages([{ role: "user", content: "q", pdf: ref }]), /读取期间/);
});

test("DeepSeek rejects PDF before network and unresolved refs cannot reach supported APIs", () => {
  const messages = [{ role: "user", content: "q", pdf: { type: "pdf" } }];
  assert.throws(() => assertPDFSupport({ provider: "deepseek" }, messages), /DeepSeek.*不支持 PDF/);
  assert.throws(() => streamModel({ profile: { provider: "deepseek" }, messages, window: { XMLHttpRequest() { assert.fail("network is forbidden"); } } }), /DeepSeek/);
  assert.throws(() => validatePDFMessages(messages), /尚未准备好/);
  for (const provider of ["openai", "chatgpt", "gemini"]) assert.doesNotThrow(() => assertPDFSupport({ provider }, messages));
});
