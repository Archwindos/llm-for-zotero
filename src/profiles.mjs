import { EFFORTS } from "./core.mjs";

export const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", model: "deepseek-flash" },
  { id: "gemini", name: "Gemini", model: "gemini-3.8-flash" },
  { id: "chatgpt", name: "OpenAI · ChatGPT 账号", model: "" },
  { id: "openai", name: "OpenAI · API Key", model: "" }
];
export const providerName = id => PROVIDERS.find(p => p.id === id)?.name || id;
export const GEMINI_LEVELS = ["low", "medium", "high"];
export const DEEPSEEK_EFFORTS = ["low", "high", "max"];

export function normalizeProfile(input) {
  if (!input || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id || "")) throw new Error("模型配置标识无效。");
  if (!PROVIDERS.some(p => p.id === input.provider)) throw new Error("请选择支持的厂家。");
  const name = String(input.name || "").trim();
  if (!name || name.length > 100) throw new Error("请为配置填写 1–100 字的名称。");
  const model = String(input.model || "").trim().replace(/^models\//, "");
  if (model && !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model)) throw new Error("请从列表选择有效模型。");
  const options = input.options || {};
  let saved;
  if (input.provider === "gemini") {
    const thinkingLevel = options.thinkingLevel || "high";
    if (!GEMINI_LEVELS.includes(thinkingLevel)) throw new Error("请选择 Gemini 支持的思考强度。");
    saved = { thinkingLevel };
  } else if (input.provider === "deepseek") {
    const effort = options.effort || "high";
    if (!DEEPSEEK_EFFORTS.includes(effort)) throw new Error("请选择 DeepSeek 支持的思考强度。");
    saved = { thinking: options.thinking === true, effort };
  } else {
    const effort = options.effort || "medium";
    if (!EFFORTS.includes(effort)) throw new Error("请选择 OpenAI 支持的思考强度。");
    saved = { effort, fast: options.fast === true };
  }
  // Only known fields are persisted. Credentials never belong in a profile.
  return { id: input.id, name, provider: input.provider, model, options: saved };
}

export function profileSummary(profile) {
  if (!profile) return "未配置模型";
  const p = normalizeProfile(profile), options = p.options;
  const detail = p.provider === "gemini" ? `思考 ${options.thinkingLevel}` : p.provider === "deepseek"
    ? options.thinking ? `思考 ${options.effort}` : "不思考" : `${options.effort}${options.fast ? " / Fast" : ""}`;
  return `${providerName(p.provider)} / ${p.model || "待选择模型"} / ${detail}`;
}

export function migrateProfiles(host) {
  const saved = host.getPref("modelProfiles", "");
  if (saved) {
    let parsed; try { parsed = JSON.parse(saved); } catch { throw new Error("模型配置无法读取，请在设置中重新保存。"); }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("模型配置列表为空，请重新添加配置。");
    return parsed.map(normalizeProfile);
  }
  const mode = host.getPref("mode", "chatgpt") === "api" ? "openai" : "chatgpt";
  const model = host.getPref(mode === "openai" ? "model" : "chatgptModel", "");
  const translationModel = host.getPref(mode === "openai" ? "translationModel" : "chatgptTranslationModel", "") || model;
  const profiles = [
    normalizeProfile({ id: "deepseek-quick", name: "DeepSeek 快速翻译", provider: "deepseek", model: host.getPref("deepseekTranslationModel", "deepseek-flash"), options: { thinking: false } }),
    normalizeProfile({ id: "gemini-default", name: "Gemini 3.8 Flash high", provider: "gemini", model: "gemini-3.8-flash", options: { thinkingLevel: "high" } }),
    normalizeProfile({ id: "openai-existing", name: "原 OpenAI 问答", provider: mode, model, options: { effort: host.getPref("effort", "medium"), fast: host.getPref("fast", false) } }),
    normalizeProfile({ id: "openai-translation", name: "原 OpenAI 翻译", provider: mode, model: translationModel, options: { effort: host.getPref("translationEffort", "medium"), fast: host.getPref("translationFast", true) } })
  ];
  // Preserve the existing translation route; the requested new chat default is Gemini.
  host.setPref("translationProfileID", host.getPref("translationProvider", "chat") === "deepseek" ? "deepseek-quick" : "openai-translation");
  host.setPref("chatProfileID", "gemini-default");
  host.setPref("modelProfiles", JSON.stringify(profiles));
  return profiles;
}
