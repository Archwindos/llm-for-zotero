// Both supported providers accept inline PDFs below 50 MB per request.
export const PDF_BYTES_LIMIT = 50_000_000;
export const GEMINI_PAYLOAD_LIMIT = 100_000_000;

export function pdfCancelled(isCancelled) {
  if (isCancelled()) throw Object.assign(new Error("已停止读取 PDF。"), { name: "AbortError" });
}

export function isPDF(bytes) {
  return bytes?.length >= 5 && bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;
}

export async function pdfBase64(window, bytes, isCancelled = () => false) {
  pdfCancelled(isCancelled);
  if (window.FileReader && window.Blob) {
    const result = await new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("PDF 编码失败，请重新载入附件。"));
      reader.readAsDataURL(new window.Blob([bytes], { type: "application/pdf" }));
    });
    pdfCancelled(isCancelled);
    return result.slice(result.indexOf(",") + 1);
  }
  // Keep chunks divisible by 3 so their independently encoded base64 can be joined.
  const parts = [], chunkSize = 3 * 16384;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    pdfCancelled(isCancelled);
    const chunk = bytes.subarray(offset, offset + chunkSize);
    parts.push((window.btoa || globalThis.btoa)(String.fromCharCode(...chunk)));
    await new Promise(resolve => (window.setTimeout || globalThis.setTimeout)(resolve, 0));
  }
  pdfCancelled(isCancelled);
  return parts.join("");
}

// Reject unresolved metadata before constructing any provider request.
export function validatePDFMessages(messages) {
  let total = 0;
  for (const message of messages) {
    if (!message.pdf) continue;
    const pdf = message.pdf;
    if (message.role !== "user" || pdf.mimeType !== "application/pdf" || typeof pdf.filename !== "string" || !pdf.filename ||
        typeof pdf.data !== "string" || !pdf.data || !Number.isSafeInteger(pdf.size) || pdf.size < 5 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf.data) || pdf.data.length % 4 ||
        pdf.data.length / 4 * 3 - (pdf.data.endsWith("==") ? 2 : pdf.data.endsWith("=") ? 1 : 0) !== pdf.size ||
        !pdf.data.startsWith("JVBERi0")) throw new Error("PDF 尚未准备好，请重新载入原文件后重试。");
    total += pdf.size;
  }
  if (total >= PDF_BYTES_LIMIT) throw new Error("一次请求的 PDF 原文件合计必须小于 50 MB，请减少附件后重试。");
  return total > 0;
}
