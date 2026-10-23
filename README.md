# LLM for Zotero

**v0.6.2 预发布版**：已完成自动测试与构建，尚未完成本版重启后的 Zotero 界面验证和真实模型 PDF 请求验证。

适用于 **Zotero 10** 的轻量论文阅读助手，支持 DeepSeek、Gemini、ChatGPT 账号和 OpenAI API。点击顶部书本对话图标，或按 `Ctrl+Shift+G` 打开侧栏。

## 日常使用

- **划词翻译**：在 PDF 中选中文字，松开后约 250 ms 发起请求；译文在原生选文弹窗中流式显示。点击“加入对话”可把原文及来源放入材料卡，继续追问。
- **PDF 原文件**：打开论文后，点击输入区左下角 **＋ → 当前 PDF 文件**。附件卡显示文件与大小，发送时直接提供原始 PDF；不再提取索引文字或截成片段，页面里的公式、图表仍在原文件中。OpenAI / ChatGPT 使用文件输入，Gemini 使用 PDF 数据；DeepSeek 暂不支持此方式，发送前会提示切换问答配置。
- **简洁输入**：输入区只有一个文本框。“＋”也可添加摘要或粘贴材料；卡片支持预览和移除。手动材料和问题不再受插件的 24,000 / 150,000 字符限制，不会静默截断；服务端的上下文限制仍适用。
- **对话问答**：输入框下方选择已保存的模型配置。`Enter` 或 `Ctrl+Enter` 发送，`Shift+Enter` 换行。发送时问题和材料附件立即从输入区清空，原文移到聊天记录中的可展开引用卡。后续追问沿用已发送的材料；失败或取消会恢复草稿。
- **历史对话**：每轮完整回答后自动保存。点击顶部时钟图标可重新打开、继续提问、手动保存或删除对话；删除前在列表中确认。PDF 历史保存 Zotero 附件引用，追问时重新读取并发送同一原文件，不将 PDF 二进制写入历史。重新打开历史时使用当前问答配置，不自动切换账号；原文件缺失或改变会明确提示。
- **Markdown 笔记**：点击回答下的“导出笔记”，编辑 Markdown、点击“插入图片”选择本地图片，再点“导出为附件”。生成 `.md` 文件，作为来源文献的存储附件；图片复制到该附件目录中的 `assets/`，使用相对链接。保留原始 Markdown 和 LaTeX，不生成 HTML，也不删除原始图片。
- **设置**：默认收起，集中放置自动翻译开关、翻译配置和问答配置。日常界面只选择配置，思考强度、Fast 等参数在“模型配置”中修改。

默认翻译沿用已有的 DeepSeek 配置，关闭深度思考，不启用联网搜索。首次升级后的默认问答配置为 **Gemini 3.8 Flash / high**。翻译和问答分别选择配置，互不改动；请求失败会明确提示，不自动换厂家。

## 配置模型

打开 **设置 → 模型配置**，选择已有配置或新增配置，填写名称、厂家，连接后从真实模型目录选择模型并保存。同一个厂家可以保存多套配置，例如“DeepSeek 快速翻译”和“DeepSeek 推理问答”。

- **DeepSeek**：使用独立 API Key；可设置深度思考开关，以及开启思考时的强度。关闭思考适合划词翻译。
- **Gemini**：使用 Google Gemini API Key，默认模型 `gemini-3.8-flash`、思考强度 `high`。Gemini 3 的强度使用 `thinkingLevel`，2.5 使用对应的思考预算。
- **OpenAI · ChatGPT 账号**：通过官方 Sign in with ChatGPT 登录，保留账号切换、添加和退出；无需另填 API Key。账号管理位于模型配置页。
- **OpenAI · API Key**：使用官方 API Key，API 独立计费。

OpenAI 配置可以独立修改思考强度和 Fast。Fast 请求 `service_tier:priority`，关闭时显式请求 `default`；实际采用的层级以服务端返回为准，界面会显示降级。模型和套餐决定哪些参数可用。

API Key 由同厂家配置共用，保存在 **Zotero 登录管理器**，保存后清空密码框。模型列表读取失败时保留已保存的精确模型，不静默替换。切换厂家会清空尚未保存的密码输入。

## 消息格式

聊天消息支持 Markdown 标题、粗体、列表、表格、引用、链接和代码块。流式生成时也会渲染；LaTeX 支持 `$...$`、`\(...\)`、`$$...$$` 和 `\[...\]`。KaTeX 及字体随插件本地打包，不从 CDN 加载。代码块中的公式字符保持原样，格式有误的公式保留可读内容。

Markdown 和公式先在 HTML 文档中构建，再导入 Zotero 界面，避免普通换行、分隔线或 HTML 实体触发 XML 解析错误。意外排版失败时显示原始文本，完整回答仍可保存到历史、复制或导出，不会因排版错误清空输出。

发送后自动滚到最新消息，流式输出仅在接近底部时跟随；向上翻阅旧消息不会被强制拉回。

## 默认阅读习惯

问答默认加入 **读论文、讲原理、说人话** 的适配指令，已按 2026-10-23 更新的阅读习惯同步适配指令。按“普通了解、可能使用、亲自实操”控制深度，先建立概念与直觉，再展开方法、公式与证据；交互式学习每轮讲一个连贯部分，等待“继续”，完整报告和指定交付按用户要求完成。维护当前对话的符号一致性，区分原文、文献事实、推断与猜测。主题结束时可生成教材版 Markdown 笔记，通过现有导出按钮保存。划词翻译仍只输出译文。

这些是模型指令，定义于 `src/instructions.mjs`，并不是带本机工具、联网或实验执行能力的 Codex skill 运行器。明确采用 MIT 许可的技能快照及支持文件保存在 `skills/installed/`，逐文件 SHA-256 见 `skills/manifest.json`。许可不明确的原始读论文快照不随公开源码分发；来源、适配范围和更新方式见 [skills/README.md](skills/README.md)。

## 数据与账号

- 自动翻译会把选中的文字发送给所选厂家；问答发送手动添加的材料、PDF 原文件与当前对话，不扫描整个文献库。PDF 在点击发送后才发送给当前厂家，添加卡片只读取本机文件信息。“不联网”指不启用联网搜索，API 请求仍需要网络。
- 各厂家 Key 和 ChatGPT OAuth token 分开保存在 Zotero 登录管理器。配置和普通偏好只保存模型、参数与配置标识，不保存密钥。
- 历史对话保存在 Zotero profile 的 `llm-for-zotero-history.json`，包含已完成问答、文本材料与 PDF 附件引用，不保存 PDF 文件内容、磁盘路径、密钥或登录 token；目前不跨设备同步。删除历史不删除原论文及已导出的文献附件。
- ChatGPT 登录使用系统浏览器、PKCE、随机 state/nonce 和签名身份验证；一次性回调只在本机回环地址临时监听。取消、完成、超时或停用后关闭。
- 退出会尝试撤销本插件会话并清理本地 token，不影响其他应用。远端撤销失败会提示。
- OpenAI 使用官方 `/v1/responses` 和 `store:false`；DeepSeek 使用官方 `/chat/completions`；Gemini 使用官方 `streamGenerateContent`。不调用 ChatGPT 私有接口，不读取其他应用的 Cookie。

## 安装与开发

从 [Releases](https://github.com/Archwindos/llm-for-zotero/releases) 下载 `llm-for-zotero-0.6.2.xpi`。本地构建产物位于 `dist/`。在 Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File 中选择。升级保留旧插件 ID、偏好和登录状态，名称改为 LLM for Zotero。

```powershell
npm ci
npm run check
```

运行插件不需要 Node、Python 或常驻服务。Node 仅用于开发打包；登录时的临时回环监听由 Zotero 自身提供。验证范围和未完成事项见 [VALIDATION.md](VALIDATION.md)。

## 范围

- 一次请求的 PDF 原文件合计须小于 50 MB；同一附件在同一请求中只发送一次，后续追问会重新发送。服务商的页数、上下文、模型视觉能力等限制仍适用；文件传输完整不代表模型一定正确读取每条公式。扫描件直接以 PDF 发送，不再依赖 Zotero 文本索引。
- 每段会话最多 20 轮，完成的轮次在本地持久保存。切换问答配置、账号或论文会开启新会话，原来的完整会话仍可从历史打开；输入草稿和未发送材料保留。失败或取消的轮次不进入历史。PDF 被修改后重新添加会开始新对话，避免把不同文件版本混为同一材料。
- 旧历史中已截断的文本不会自动补齐；需要全文时请重新添加 PDF。划词即时翻译仍保留 24,000 字符保护，仅作用于翻译，不截断加入问答的材料。
- 仅完整译文进入最近 30 条缓存，缓存按厂家凭据、模型、参数和选文区分。关闭弹窗、换选文或换翻译配置会取消旧请求；失败可重试。
- 导出笔记需要可写的文献及附件存储权限；来源以发送时捕获的文献为准，没有捕获来源时使用当前所选文献，不退回为文献库中的独立条目。通过“插入图片”添加的本地图片随附件保存；手写远程图片地址保留链接，不自动下载。不提供批量文献上传、向量数据库或自动代理。
- 本地发行版需手动更新。Zotero 要求的 `update_url` 使用保留的 `.invalid` 域名。

## 参考

- [ChatGPT 使用指南](https://learn.chatgpt.com/docs/web)：参考单输入框、添加菜单和按需展开材料的交互。
- [Zotero PDF Translate](https://github.com/windingwind/zotero-pdf-translate)：参考原生选文弹窗交互，未复制其 AGPL 源码。
- [Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide)：参考材料卡、集中输入区和简洁侧栏。
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Gemini 思考模式](https://ai.google.dev/gemini-api/docs/thinking)
- [OpenAI 文件输入](https://developers.openai.com/api/docs/guides/file-inputs)
- [Gemini 文档理解](https://ai.google.dev/gemini-api/docs/generate-content/document-processing)
- [Gemini 文件输入方式与限制](https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods)
- [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Zotero 插件开发](https://www.zotero.org/support/dev/client_coding/plugin_development)

使用 marked、DOMPurify、KaTeX 与 jose；许可证随 XPI 打包在 `THIRD_PARTY_NOTICES.txt`。图标为本项目原创 SVG。本插件为独立项目。



## 许可证

原创插件代码采用 [MIT](LICENSE)，Copyright (c) 2026 Archwindos。第三方组件保留其许可证，详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
