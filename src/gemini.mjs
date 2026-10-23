import { SSEParser } from "./core.mjs";
import { CHAT_INSTRUCTIONS } from "./instructions.mjs";
import { GEMINI_PAYLOAD_LIMIT, validatePDFMessages } from "./pdf.mjs";

export const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODEL = "gemini-3.8-flash";

function geminiError(status) {
  if (status === 400) return "Gemini 拒绝了请求，请检查模型、思考强度或选文长度。";
  if (status === 401 || status === 403) return "Gemini 密钥或权限不可用，请在模型配置中检查 Key 与项目权限。";
  if (status === 404) return "Gemini 模型已停用或不可用，请刷新模型列表后重新选择。";
  if (status === 429) return "Gemini 配额不足或请求过于频繁，请检查项目配额后重试。";
  return `Gemini 请求失败（HTTP ${status || "网络错误"}），请检查网络后重试。`;
}

export function listGeminiModels(window, key) {
  let xhr, cancelled = false;
  const promise = (async () => {
    const models = [];
    let token = "";
    do {
      const page = await new Promise((resolve, reject) => {
        xhr = new window.XMLHttpRequest({ mozAnon: true });
        xhr.open("GET", `${GEMINI_ROOT}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
        xhr.setRequestHeader("x-goog-api-key", key); xhr.timeout = 20000;
        xhr.onload = () => {
          if (xhr.status !== 200) return reject(new Error(geminiError(xhr.status)));
          try { const value = JSON.parse(xhr.responseText); if (!Array.isArray(value.models)) throw new Error(); resolve(value); }
          catch { reject(new Error("Gemini 模型列表格式异常，请重试。")); }
        };
        xhr.onerror = () => reject(new Error(geminiError(0)));
        xhr.ontimeout = () => reject(new Error("Gemini 模型列表读取超时。"));
        xhr.onabort = () => reject(new Error("Gemini 模型列表读取已取消。"));
        if (cancelled) { reject(new Error("Gemini 模型列表读取已取消。")); return; }
        xhr.send();
      });
      models.push(...page.models.filter(m => m.supportedGenerationMethods?.includes("generateContent") && /^models\/gemini-/.test(m.name) && !/image|tts|transcrib|robotics|computer-use/.test(m.name))
        .map(m => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name })));
      token = page.nextPageToken || "";
    } while (token && !cancelled);
    return models;
  })();
  return { promise, cancel() { cancelled = true; xhr?.abort(); } };
}

export function streamGemini({ window, key, model = GEMINI_MODEL, thinkingLevel = "high", messages,
  instructions = CHAT_INSTRUCTIONS, onText, onComplete = () => {} }) {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(model)) throw new Error("请从列表选择有效的 Gemini 模型。");
  if (!["low", "medium", "high"].includes(thinkingLevel)) throw new Error("请选择 Gemini 支持的思考强度。");
  const hasPDF = validatePDFMessages(messages);
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [
    ...(m.pdf ? [{ inlineData: { mimeType: "application/pdf", data: m.pdf.data } }] : []), { text: m.content }
  ] }));
  const thinkingConfig = /^gemini-2\.5-/.test(model)
    ? { thinkingBudget: { low: 1024, medium: 4096, high: 8192 }[thinkingLevel] }
    : { thinkingLevel: thinkingLevel.toUpperCase() };
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: instructions }] }, contents,
    generationConfig: { thinkingConfig, maxOutputTokens: 16384 } });
  if (hasPDF && new TextEncoder().encode(body).byteLength >= GEMINI_PAYLOAD_LIMIT) throw new Error("Gemini 请求总大小必须小于 100 MB，请减少附件或对话后重试。");
  const xhr = new window.XMLHttpRequest({ mozAnon: true });
  let settled = false, text = "", offset = 0, completed = false, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const parser = new SSEParser(event => {
      if (settled) return;
      if (event.error) throw new Error(geminiError(event.error.code));
      if (event.promptFeedback?.blockReason) throw new Error("Gemini 拒绝处理这段内容，请调整选文后重试。");
      const candidate = event.candidates?.[0];
      if (!candidate) return;
      for (const part of candidate.content?.parts || []) {
        if (part.text && !part.thought) { text += part.text; onText(text); }
      }
      if (candidate.finishReason) {
        if (candidate.finishReason !== "STOP") throw new Error("Gemini 回答未完成，请缩短材料或调整配置后重试。");
        if (!text.trim()) throw new Error("Gemini 未返回正文，请重试。");
        completed = true; onComplete({ model: event.modelVersion, usage: event.usageMetadata });
        settled = true; resolve(text);
      }
    });
    const consume = final => { const next = xhr.responseText.slice(offset); offset = xhr.responseText.length; parser.push(next, final); };
    xhr.open("POST", `${GEMINI_ROOT}/models/${model}:streamGenerateContent?alt=sse`);
    xhr.setRequestHeader("x-goog-api-key", key); xhr.setRequestHeader("Content-Type", "application/json"); xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.timeout = 180000;
    xhr.onprogress = () => { if (xhr.status !== 200 || settled) return; try { consume(false); } catch (error) { fail(error); xhr.abort(); } };
    xhr.onload = () => {
      if (settled) return;
      if (xhr.status !== 200) return fail(new Error(hasPDF && [400, 413].includes(xhr.status)
        ? "Gemini 拒绝了 PDF 请求，请检查所选模型是否支持文档，并减少附件大小或重新载入 PDF。" : geminiError(xhr.status)));
      try { consume(true); if (!completed) throw new Error("Gemini 连接在回答完成前中断，当前文字不完整。"); }
      catch (error) { fail(error); }
    };
    xhr.onerror = () => fail(new Error(geminiError(0)));
    xhr.ontimeout = () => fail(new Error("Gemini 请求超过 3 分钟，请稍后或缩短材料重试。"));
    xhr.onabort = () => fail(Object.assign(new Error("已停止生成。"), { name: "AbortError" }));
    xhr.send(body);
  });
  return { promise, cancel() {
    if (settled) return; xhr.abort();
    if (!settled) { settled = true; rejectPromise(Object.assign(new Error("已停止生成。"), { name: "AbortError" })); }
  } };
}
