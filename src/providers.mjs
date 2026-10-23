import { streamResponse, listModels } from "./api.mjs";
import { streamDeepSeekTranslation, listDeepSeekModels } from "./deepseek.mjs";
import { streamGemini, listGeminiModels } from "./gemini.mjs";
import { normalizeProfile } from "./profiles.mjs";
import { CHAT_INSTRUCTIONS } from "./instructions.mjs";

export function providerModels(window, key, provider) {
  if (provider === "gemini") return listGeminiModels(window, key);
  if (provider === "deepseek") return listDeepSeekModels(window, key);
  if (["chatgpt", "openai"].includes(provider)) return listModels(window, key, provider === "chatgpt" ? "chatgpt" : "api");
  throw new Error("不支持此模型厂家。");
}

export function streamModel({ profile, instructions = CHAT_INSTRUCTIONS, ...request }) {
  assertPDFSupport(profile, request.messages);
  const p = normalizeProfile(profile);
  if (!p.model) throw new Error("请在模型配置中选择模型并保存。");
  if (p.provider === "gemini") return streamGemini({ ...request, model: p.model, thinkingLevel: p.options.thinkingLevel, instructions });
  if (p.provider === "deepseek") return streamDeepSeekTranslation({ ...request, model: p.model, thinking: p.options.thinking, effort: p.options.effort, instructions });
  return streamResponse({ ...request, model: p.model, mode: p.provider === "chatgpt" ? "chatgpt" : "api", ...p.options, instructions });
}

export function assertPDFSupport(profile, messages) {
  if (messages.some(message => message.pdf) && profile.provider === "deepseek") throw new Error("DeepSeek 当前不支持 PDF 原文件，请切换到 OpenAI、ChatGPT 或 Gemini 模型配置。");
}
