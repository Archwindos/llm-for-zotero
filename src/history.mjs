const contextKeys = ["text", "title", "kind", "itemID", "uri", "page", "truncated", "originalLength", "libraryID", "itemKey", "type", "attachmentID", "attachmentKey", "attachmentLibraryID", "filename", "size", "modifiedTime"];
const sourceCopy = (value, material = false) => value ? Object.fromEntries(contextKeys.filter(key => (material || key !== "text") && ["string", "number", "boolean"].includes(typeof value[key])).map(key => [key, value[key]])) : null;

export function conversationCopy(value) {
  if (!value || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !Array.isArray(value.turns) || !value.turns.length || value.turns.length > 20) throw new Error("历史对话格式异常，原文件未修改。");
  const turns = value.turns.map(turn => {
    if (typeof turn.question !== "string" || typeof turn.answer !== "string" || !turn.answer.trim() || turn.partial) throw new Error("历史对话包含未完成的回答，原文件未修改。");
    return { question: turn.question, answer: turn.answer, material: sourceCopy(turn.material, true), source: sourceCopy(turn.source), role: String(turn.role || "助手"), mode: String(turn.mode || ""), date: String(turn.date || "") };
  });
  return { id: value.id, title: turns[0].question.trim().slice(0, 60), createdAt: value.createdAt, updatedAt: value.updatedAt, turns };
}

// All windows share this queue. Failed atomic writes leave the previous file intact.
export class ConversationStore {
  constructor(io) { this.io = io; this.queue = Promise.resolve(); }
  run(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  async read() {
    const text = await this.io.read(); if (text == null) return [];
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("历史文件无法读取，原文件已保留，请先备份后修复。"); }
    if (data.version !== 1 || !Array.isArray(data.conversations)) throw new Error("历史文件版本异常，原文件已保留。");
    return data.conversations.map(conversationCopy);
  }
  list() { return this.run(async () => (await this.read()).map(({ turns, ...entry }) => entry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  get(id) { return this.run(async () => { const entry = (await this.read()).find(c => c.id === id); if (!entry) throw new Error("这段历史对话已被删除。"); return entry; }); }
  save(value) {
    const entry = conversationCopy(value);
    return this.run(async () => {
      const entries = await this.read(), index = entries.findIndex(c => c.id === entry.id);
      if (index < 0) entries.push(entry); else entries[index] = entry;
      await this.io.write(JSON.stringify({ version: 1, conversations: entries })); return entry;
    });
  }
  delete(id) { return this.run(async () => { const entries = (await this.read()).filter(c => c.id !== id); await this.io.write(JSON.stringify({ version: 1, conversations: entries })); }); }
}
