import { SSEParser, modelCatalog } from "./core.mjs";
import { TRANSLATION_INSTRUCTIONS } from "./instructions.mjs";

export const DEEPSEEK_ROOT = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-flash";

function deepSeekError(status) {
  if (status === 401) return "DeepSeek Key 无效或已失效，请在模型配置中重新填写。";
  if (status === 402) return "DeepSeek API 余额不足，请充值后重试。";
  if (status === 429) return "DeepSeek 请求过于频繁，请稍后再试。";
  if (status === 400 || status === 404) return "DeepSeek 模型或请求不可用，请在模型配置中刷新模型列表后重试。";
  return `DeepSeek 请求失败（HTTP ${status || "网络错误"}），请稍后重试。`;
}

export function listDeepSeekModels(window, key) {
  const xhr = new window.XMLHttpRequest({ mozAnon: true });
  const promise = new Promise((resolve, reject) => {
    xhr.open("GET", `${DEEPSEEK_ROOT}/models`);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.timeout = 20000;
    xhr.onload = () => {
      if (xhr.status !== 200) return reject(new Error(deepSeekError(xhr.status)));
      try { resolve(modelCatalog(JSON.parse(xhr.responseText), "api").filter(m => m.id !== "deepseek-reasoner")); }
      catch { reject(new Error("DeepSeek 模型列表返回格式异常。")); }
    };
    xhr.onerror = () => reject(new Error(deepSeekError(0)));
    xhr.ontimeout = () => reject(new Error("DeepSeek 连接超时，请稍后重试。"));
    xhr.onabort = () => reject(new Error("DeepSeek 连接测试已取消。"));
    xhr.send();
  });
  return { promise, cancel: () => xhr.abort() };
}

// Every profile explicitly controls thinking; no profile enables web search or tools.
export function streamDeepSeekTranslation({ window, key, model = DEEPSEEK_MODEL, messages, thinking = false, effort = "high",
  instructions = TRANSLATION_INSTRUCTIONS, onText, onComplete = () => {} }) {
  const xhr = new window.XMLHttpRequest({ mozAnon: true });
  let settled = false, offset = 0, text = "", completed = false, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const finish = model => {
      if (settled) return;
      if (!text.trim()) throw new Error("DeepSeek 未返回正文，请重试。");
      completed = true; onComplete({ model }); settled = true; resolve(text);
    };
    const parser = new SSEParser(event => {
      if (settled) return;
      if (event.error) throw new Error(deepSeekError(0));
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.delta?.content) { text += choice.delta.content; onText(text); }
      if (choice.finish_reason) {
        if (choice.finish_reason !== "stop") throw new Error("DeepSeek 翻译未完成，请缩短选文后重试。");
        finish(event.model);
      }
    }, () => finish(model));
    const consume = final => {
      const next = xhr.responseText.slice(offset); offset = xhr.responseText.length;
      parser.push(next, final);
    };
    xhr.open("POST", `${DEEPSEEK_ROOT}/chat/completions`);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.timeout = thinking ? 180000 : 90000;
    xhr.onprogress = () => {
      if (xhr.status !== 200 || settled) return;
      try { consume(false); } catch (error) { fail(error); xhr.abort(); }
    };
    xhr.onload = () => {
      if (settled) return;
      if (xhr.status !== 200) return fail(new Error(deepSeekError(xhr.status)));
      try {
        consume(true);
        if (!completed) throw new Error("DeepSeek 连接在翻译完成前中断，当前译文不完整。");
      } catch (error) { fail(error); }
    };
    xhr.onerror = () => fail(new Error(deepSeekError(0)));
    xhr.ontimeout = () => fail(new Error("DeepSeek 请求超时，请稍后或缩短选文重试。"));
    xhr.onabort = () => fail(Object.assign(new Error("已停止翻译。"), { name: "AbortError" }));
    xhr.send(JSON.stringify({ model, messages: [{ role: "system", content: instructions }, ...messages],
      thinking: { type: thinking ? "enabled" : "disabled" }, ...(thinking ? { reasoning_effort: effort } : {}),
      tool_choice: "none", stream: true, max_tokens: 16384 }));
  });
  return { promise, cancel() {
    if (settled) return;
    xhr.abort();
    if (!settled) { settled = true; rejectPromise(Object.assign(new Error("已停止翻译。"), { name: "AbortError" })); }
  } };
}
