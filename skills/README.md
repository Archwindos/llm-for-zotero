# 阅读指令及来源

`src/instructions.mjs` 中的统一指令默认启用读论文、讲原理、说人话三项习惯，按用户需求同步于 2026-10-23。它是发送给模型的提示词，不是具有本机工具、浏览器、代码执行或文件写入能力的 skill 运行器。划词翻译使用独立指令。

插件保留学习目的与深度、概念层级、分块讲解、证据边界、一致符号、教材版 Markdown 笔记及现有待办状态；完整报告或指定交付遵从用户要求。笔记通过现有 Markdown 导出功能保存。

公开源码只随附明确提供 MIT 许可证的 tech-explain 与 plain-chat 快照及其完整支持文件。其来源及逐文件哈希见 `manifest.json`，版权及许可见各自 LICENSE 和根目录 THIRD_PARTY_NOTICES.txt。

读论文流程参考 [PaperForge](https://github.com/FeijiangHan/PaperForge)，固定来源提交为 `715487ccda2b0eea130a388040bc8d5d819da40b`。安装快照和该上游提交根目录没有明确许可，因此本次不分发其原始 skill 文件；`manifest.json` 明确记录排除状态。插件保留根据用户阅读要求编写的适配指令，项目 MIT 许可不为未分发的第三方原文授予权利。

原开发环境的完整 skill 快照和同步脚本仅留在本地；公开版本不含机器路径。需要调整阅读行为时，编辑 `src/instructions.mjs`，复核范围与事实边界，更新 manifest 中该文件的 SHA-256，并运行 `npm run check`。本项目不自动下载或激活 Codex skills，不安装 hooks。
