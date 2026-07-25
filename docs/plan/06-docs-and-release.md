# P6：文档与发布准备

> 依赖：P5
> 目标：产出可开源的文档。
> 设计依据：设计文档 §6.2、§6.4、§7。
> 重要约束（§7.1）：README 只描述本 MCP 自身能力，**不内置**任何「建议配合 linkseek」的引导——那是 honlnk-skills 的职责。

## 任务清单

- [ ] `README.md`
  - 项目定位一句话（本地图片识别 MCP，让单模态模型获得视觉能力）
  - 功能：3 个工具的简述
  - 安装：`pnpm` / `npx` 两种
  - 配置：环境变量表（DEFAULT_PROVIDER / OPENAI_* / TIMEOUT_MS）
  - **ZCode 接入指南**（设计文档 §7：其他 Agent 暂不考虑）
    - mcp 配置示例（command / args / env）
    - 单模态模型场景说明（§5.3.1：ZCode 把图片转成 URL 传入）
  - 图片限制：5MB / jpg/jpeg/png
  - 多轮迭代用法示例
  - 多 provider 配置示例（OpenAI；Qwen/Kimi 标注「后续支持」）
- [ ] `.env.example`
  - 列出所有支持的环境变量及注释
- [ ] `package.json` 完善
  - `description` / `keywords` / `license` / `repository` / `engines`
  - `bin` 指向 `dist/index.js`（支持 `npx picsense`）
  - `files` 字段（只发布 dist + README）
- [ ] 可选：`docs/usage-examples.md`（更多使用场景的 prompt 示例，参考附录 A.6 的结构化 prompt 思路）

## 验收

- README 可让新用户 10 分钟内跑通本地识别
- `.env.example` 覆盖所有配置项
- 设计文档 §7 的开源 checklist 全部勾选（README 完整 / ZCode 指南 / 多 provider 示例）
