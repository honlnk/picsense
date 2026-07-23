# picsense 开发总计划（Master Plan）

> 本文档是开发进度的「单一事实来源」。每个阶段完成后回到这里勾选状态。
> 设计依据：`docs/picsense-design.md`（v0.4, 2026-07-24）。

## 一、交付目标（验收标准）

一个 **本地 stdio MCP**，对外暴露 3 个工具：

| 工具 | 验收点 |
|------|--------|
| `analyze_images` | 接收 `image_sources: string[]`（URL / 本地路径 / base64 自动识别）+ `prompt` + 可选 `session_id`；支持多轮迭代；返回 `{session_id, summary, description}` |
| `list_sessions` | 返回当前所有 session 列表（含 summary / 关联图片 / 迭代轮数 / 最后访问时间） |
| `analyze_document` | 接收文档（URL/HTML/markdown），识别其中所有图片，返回标注了图片描述的完整文档 |

非功能验收：
- 单张图片 ≤ 5MB，格式 jpg/jpeg/png
- Session 过期 24 小时，进程退出即清空（纯内存态，不持久化）
- 多 provider 架构（`VisionProvider` 接口），首版实现 OpenAI 适配器
- 全部配置走环境变量（API Key / 模型名 / 默认 provider），代码内零硬编码
- TypeScript + pnpm + `@modelcontextprotocol/sdk` + zod

## 二、阶段拆分（由各自 plan 文档驱动）

| 阶段 | 计划文档 | 状态 | 产出 |
|------|---------|------|------|
| P1 | [01-scaffolding.md](./01-scaffolding.md) | ✅ 完成 | 可编译的空壳工程 |
| P2 | [02-providers.md](./02-providers.md) | ✅ 完成 | 图片加载 + OpenAI provider 可独立跑通 |
| P3 | [03-session-manager.md](./03-session-manager.md) | ✅ 完成 | Session 生命周期 + 并发隔离 |
| P4 | [04-tools.md](./04-tools.md) | ✅ 完成 | 3 个工具的业务逻辑 |
| P5 | [05-mcp-entry.md](./05-mcp-entry.md) | ✅ 完成 | stdio 入口 + 端到端可被 MCP 客户端调用 |
| P6 | [06-docs-and-release.md](./06-docs-and-release.md) | ✅ 完成 | README / .env.example / 接入指南 |

## 三、开发顺序的依赖关系

```
P1 (脚手架)
  └─> P2 (providers + image-loader)   ← 业务核心，最早可被验证
        └─> P3 (session-manager)
              └─> P4 (tools)
                    └─> P5 (MCP 入口)
                          └─> P6 (文档)
```

P2 的 OpenAI provider 一旦能调通一张图，后续阶段的风险就基本消除。所以 **P2 完成后做一次端到端冒烟验证**。

## 四、技术约束（贯穿所有阶段）

1. **语言**：TypeScript，`strict: true`
2. **包管理**：pnpm，Node ≥ 20（开发机为 v24）
3. **MCP SDK**：`@modelcontextprotocol/sdk`，stdio 传输
4. **校验**：zod（SDK 内置）
5. **HTTP**：仅用 Node 内置 `fetch`，不引入 axios 等第三方 HTTP 库（与智谱方案、附录 A.1 的零依赖策略一致）
6. **零硬编码配置**：provider / model / key 全部来自环境变量
7. **不持久化**：session 是内存态 Map，进程退出即销毁
8. **prompt 控制权交给基座模型**：MCP 内部不预设场景化 system prompt（详见设计文档 §2.3）

## 五、风险与对策

| 风险 | 对策 |
|------|------|
| OpenAI vision API 字段细节（多图传入方式、base64 格式）| P2 开始前先查官方文档，写进 `02-providers.md` 的「调研结论」小节 |
| 多轮 session 的 messages 结构如何对应视觉模型 API | P3 在 plan 里明确 messages 的 role/content 布局 |
| `analyze_document` 抓 URL 文档的健壮性 | 首版只做最小可用：fetch HTML → 抽 `<img>` 和 markdown `![]()` → 逐张识别 → 插注释；不做 JS 渲染 |
| 同一 session 并发写 | session 级互斥锁（设计文档 §4.2.4） |

## 六、状态图例

- ⬜ 未开始
- 🔄 进行中
- ✅ 完成
- ⚠️ 阻塞（需讨论）
