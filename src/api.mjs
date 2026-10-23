import { API_ROOT, INSTRUCTIONS, SSEParser, apiError, requestOptions, modelCatalog } from "./core.mjs";
import { validatePDFMessages } from "./pdf.mjs";

export function streamResponse({ window, key, model, messages, mode = "api", effort = "medium", fast = false, instructions = INSTRUCTIONS, onText, onComplete = () => {} }) {
  const hasPDF = validatePDFMessages(messages);
  const input = messages.map(m => m.pdf ? { role: m.role, content: [
    { type: "input_file", filename: m.pdf.filename, file_data: `data:application/pdf;base64,${m.pdf.data}` },
    { type: "input_text", text: m.content }
  ] } : { role: m.role, content: m.content });
  const options = requestOptions(model, effort, fast);
  const xhr = new window.XMLHttpRequest({ mozAnon: true });
  let settled = false, text = "", offset = 0, completed = false;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const parser = new SSEParser(event => {
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        text += event.delta || "";
        onText(text);
      }
      if (event.type === "response.completed") {
        completed = true;
        onComplete({ tier: event.response?.service_tier, model: event.response?.model });
        if (!text) {
          text = (event.response?.output || []).flatMap(i => i.content || []).map(c => c.text || c.refusal || "").join("");
          onText(text);
        }
      }
      if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
        throw new Error(event.type === "response.incomplete" ? "回答未完成（可能达到模型输出上限）。可减少材料后重试。" : apiError(0, mode, event.response?.error?.code || event.error?.code || event.code));
      }
    });
    const consume = final => {
      const next = xhr.responseText.slice(offset);
      offset = xhr.responseText.length;
      parser.push(next, final);
    };
    xhr.open("POST", `${API_ROOT}/responses`);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.timeout = 180000;
    xhr.onprogress = () => {
      if (xhr.status !== 200 || settled) return;
      try { consume(false); } catch (e) { fail(e); xhr.abort(); }
    };
    xhr.onload = () => {
      if (settled) return;
      if (xhr.status !== 200) {
        if (hasPDF && [400, 413].includes(xhr.status)) return fail(new Error(xhr.status === 413
          ? "PDF 请求超过服务大小限制，请减少附件后重试。" : "OpenAI 拒绝了 PDF 请求，请确认所选模型支持 PDF 与视觉输入，并检查文件大小或重新载入 PDF。"));
        let code; try { code = JSON.parse(xhr.responseText)?.error?.code; } catch {}
        return fail(new Error(apiError(xhr.status, mode, code)));
      }
      try {
        consume(true);
        if (!completed) throw new Error("连接在回答完成前中断；当前文字是不完整回答。");
        if (!text.trim()) throw new Error("OpenAI 没有返回文字内容，请重试。");
        settled = true;
        resolve(text);
      } catch (e) { fail(e); }
    };
    xhr.onerror = () => fail(new Error(apiError(0)));
    xhr.ontimeout = () => fail(new Error("请求超过 3 分钟，请检查网络或减少材料后重试。"));
    xhr.onabort = () => fail(Object.assign(new Error("已停止生成；当前文字尚未完成。"), { name: "AbortError" }));
    xhr.send(JSON.stringify({ ...options, instructions, input, stream: true, store: false }));
  });
  return { promise, cancel() {
    if (settled) return;
    xhr.abort();
    if (!settled) {
      settled = true;
      rejectPromise(Object.assign(new Error("已停止生成。"), { name: "AbortError" }));
    }
  } };
}

export function listModels(window, key, mode = "api") {
  const xhr = new window.XMLHttpRequest({ mozAnon: true });
  const promise = new Promise((resolve, reject) => {
    xhr.open("GET", `${API_ROOT}/models`);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.timeout = 20000;
    xhr.onload = () => {
      if (xhr.status !== 200) return reject(new Error(apiError(xhr.status, mode)));
      try { resolve(modelCatalog(JSON.parse(xhr.responseText), mode)); }
      catch { reject(new Error("模型列表返回格式异常。")); }
    };
    xhr.onerror = () => reject(new Error(apiError(0)));
    xhr.ontimeout = () => reject(new Error("连接测试超时，请检查网络。"));
    xhr.onabort = () => reject(new Error("连接测试已取消。"));
    xhr.send();
  });
  return { promise, cancel: () => xhr.abort() };
}

export function checkKey(window, key) {
  const request = listModels(window, key);
  return { promise: request.promise.then(models => models.map(m => m.id)), cancel: request.cancel };
}
