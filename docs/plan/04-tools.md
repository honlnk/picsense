# P4：三个工具的业务逻辑

> 依赖：P2、P3
> 目标：实现 `analyze_images` / `list_sessions` / `analyze_document` 的业务逻辑。
> 设计依据：设计文档 §4.1 / §4.2.5。
> 本阶段只写**纯函数**（接收参数、返回结果），不涉及 MCP 注册——那是 P5 的事。

## 4.1 analyze_images（`src/tools/analyze-images.ts`）

```typescript
async function analyzeImages(params: {
  image_sources: string[];
  prompt: string;
  session_id?: string;
}): Promise<{
  session_id: string;
  summary: string;
  description: string;
}>
```

- [ ] 校验：`image_sources` 非空、`prompt` 非空
- [ ] 分支：
  - 无 `session_id` → `sessionManager.createSession()`
  - 有 `session_id` → `sessionManager.appendTurn()`
- [ ] 返回结构与设计文档 §4.2.5 完全一致

## 4.2 list_sessions（`src/tools/list-sessions.ts`）

```typescript
async function listSessions(): Promise<{
  sessions: Array<{
    session_id: string;
    summary: string;
    image_sources: string[];  // 截断显示（每项超长则只留前后缀）
    last_access_at: number;
    iteration: number;
  }>
}>
```

- [ ] 从 sessionManager 读快照
- [ ] image_sources 做截断（长 URL/path 只保留头尾，中间 `...`）

## 4.3 analyze_document（`src/tools/analyze-document.ts`）

```typescript
async function analyzeDocument(params: { document: string }): Promise<{
  document: string;        // 标注后的完整文档
  images_analyzed: number;
}>
```

> 设计文档 §4.2.5：职责单一——输入文档、输出文档。内置识别 prompt，不接收外部 prompt。

- [ ] 自动识别 document 形态：
  - `http(s)://` → fetch 拿正文（用内置 fetch，首版不做 JS 渲染）
  - 含 `<img` 或 `<` → 当 HTML
  - 否则当 markdown
- [ ] 抽取所有图片引用：
  - HTML：`<img src="...">` 正则
  - markdown：`![alt](url)`
- [ ] 对每张图调 provider 识别（用固定内置 prompt，如 "Describe this image concisely"）
- [ ] 标注插入（设计文档 §4.2.5 示例）：
  - markdown：图片行下一行加 `<!-- image-vision: <描述> -->`
  - HTML：`<img>` 后加 `<!-- image-vision: <描述> -->`
- [ ] 大量图片时的策略：逐张串行（避免 rate limit；后续可优化并发，首版保守）
- [ ] 图片识别失败的容错：保留原图，注释标 `<!-- image-vision: [识别失败: 原因] -->`

## 验收

- 三个函数的输入输出与设计文档 schema 一一对应
- 不依赖 MCP SDK（纯业务，便于单测和 P5 复用）
