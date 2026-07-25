# P5：MCP 入口 + stdio 传输

> 依赖：P2、P3、P4
> 目标：把三个工具注册进 MCP Server，经 stdio 可被 MCP 客户端调用。

## 任务清单

### 5.1 Server 搭建（`src/index.ts`）

- [ ] 用 `@modelcontextprotocol/sdk` 创建 `McpServer`
- [ ] 传输方式：`StdioServerTransport`
- [ ] Server name: `picsense`，version 从 package.json 读

### 5.2 工具注册

每个工具用 `server.tool(name, description, zodSchema, handler)` 注册：

- [ ] `analyze_images`
  - description：见设计文档 §4.2.5（"识别图片内容。传入一张图片为单图识别…"）
  - zod schema：`{ image_sources: z.array(z.string()).min(1), prompt: z.string(), session_id: z.string().optional() }`
  - handler 调 `analyzeImages()`，返回结构化 content
- [ ] `list_sessions`
  - description：见设计文档 §4.2.5
  - 无参数
  - handler 调 `listSessions()`
- [ ] `analyze_document`
  - description：见设计文档 §4.2.5
  - zod schema：`{ document: z.string() }`
  - handler 调 `analyzeDocument()`

### 5.3 返回值格式

设计文档 §3.4 强调「返回结果只返回识别内容本身，不带元信息」——但 §4.2.5 的 schema 又明确返回 `{session_id, summary, description}`。

> **澄清**：§3.4 说的是「不要返回调试性元信息（耗时/模型/第几轮）」。`session_id` 是多轮迭代的功能必需（下一轮要回传），`summary` 是 session 的功能字段，`description` 是识别内容本体——这三者是**功能字段而非调试元信息**，必须返回。这与 §4.2.5 的 schema 一致。

- [ ] 返回值用 `JSON.stringify` 包成文本 content（MCP 工具返回标准做法）
- [ ] 控制台日志走 `stderr`（stdio MCP 禁止 stdout 输出调试信息）

### 5.4 启动/关闭

- [ ] 启动时校验环境变量（config 缺失则友好报错到 stderr 后退出）
- [ ] 进程退出时 sessionManager 的内存自然清空（无需额外处理——设计文档 §4.2.2 明确内存态不持久化）
- [ ] 定时清理任务随进程生命周期启停

### 5.5 端到端验证

- [ ] `pnpm build` 成功
- [ ] 用 MCP inspector 或一个最小 stdio 客户端脚本：
  - 列出工具 → 看到 3 个
  - 调 `analyze_images`（真实图 + 真实 key）→ 拿到 description + session_id
  - 用返回的 session_id 再调一次 → 拿到迭代后的 description
  - 调 `list_sessions` → 看到该 session
- [ ] 验证 stderr 日志、stdout 干净

## 验收

- 一个真实 MCP 客户端能完整走通「单图识别 → 多轮迭代 → 列表」流程
- 设计文档 §4.1 的三个工具全部可用
