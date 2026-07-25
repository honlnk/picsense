# P2：Provider 抽象 + 图片加载

> 依赖：P1
> 目标：图片能从三种来源加载，并能通过 OpenAI provider 成功识别一张图。
> 这是整个项目风险最高的一环——完成后做端到端冒烟。

## 任务清单

### 2.1 image-loader（`src/core/image-loader.ts`）

- [ ] 实现 `loadImage(source: string): Promise<LoadedImage>`
  - 自动识别来源：`http(s)://` URL / 本地文件路径 / `data:` base64
  - 返回统一形态：`{ dataUrl: string, mimeType: string }`
    - URL：直接返回原 URL（视觉模型 API 直接消费，避免把图床预签名 URL 转成 base64，参考附录 A.4）
    - 本地路径：`fs.readFile` → base64 → `data:image/xxx;base64,...`
    - base64 字符串：补全 data URL 前缀
- [ ] 校验
  - 格式白名单：jpg / jpeg / png（其余报错）
  - 大小限制：单张 ≤ 5MB（对本地文件 `fs.stat` 检查；对 URL 在 fetch 后检查 content-length 或下载字节数）
  - base64 输入按解码后字节数估算

### 2.2 VisionProvider 接口（`src/providers/index.ts`）

参考 `@systemmin/image-mcp`（设计文档 §5.2.2）。

```typescript
interface VisionMessage {
  role: 'user' | 'assistant';
  content: string;  // 纯文本（assistant 回复，或 user 的文字 prompt）
}

interface VisionRequest {
  images: LoadedImage[];   // 首轮带图，后续轮次历史里也要保留图的引用
  messages: VisionMessage[]; // 多轮对话历史
  generateSummary?: boolean; // 首轮调用时为 true
}

interface VisionResponse {
  description: string;
  summary?: string;        // 仅 generateSummary=true 时返回
}

interface VisionProvider {
  name: string;
  analyze(req: VisionRequest): Promise<VisionResponse>;
}

function getProvider(name: string): VisionProvider;  // 工厂
```

> **设计决策（messages 布局）**：多轮对话历史里，图片只在 **首轮 user message** 出现一次（对应 OpenAI 多模态 messages 标准）。后续 user turn 只放文字。这与设计文档 §4.2「原生多轮对话，完整的 messages 数组」一致。messages 布局细节在 P3 session-manager 里组织，provider 只负责把 `images + messages` 拼成 API payload。

### 2.3 OpenAI provider（`src/providers/openai.ts`）

- [x] 实现 `OpenAIProvider implements VisionProvider`
- [x] 调研结论（已实测 vibebabo.com 网关 + gpt-5.6-sol 确认，**使用 Responses API 原生格式**）：
  - **endpoint**：`POST {baseUrl}/responses`（**非** chat/completions）
  - baseUrl 规范化：用户传 `https://api.openai.com` 或 `https://vibebabo.com/v1` 均可，代码自动保证以 `/v1` 结尾
  - 鉴权：`Authorization: Bearer ${OPENAI_API_KEY}`
  - model：`OPENAI_MODEL`（如 `gpt-5.6-sol`）
  - **请求体用 `input` 数组**（非 `messages`）：每项 `{role, content}`，content part 类型为 `input_text` / `input_image`
  - 多图：首轮 user 的 content 放多个 `{type:'input_image', image_url}` + 一个 `{type:'input_text'}`
  - image_url：可为 `https://...`（直传）或 `data:image/png;base64,...`（base64）
  - **多轮**：input 数组里多条 user/assistant 消息，assistant 历史轮 content 用 `[{type:'output_text', text}]`（实测验证模型有跨轮记忆）
  - **响应**：从 `output[].content[]` 中取 `type==='output_text'` 的 `text` 拼接
- [x] 重试：`withRetry(fn, 2, 1000)`（参考附录 A.4，仅对 5xx/429/网络错误重试）
- [x] 超时：默认 300s，可被 `TIMEOUT_MS` 覆盖
- [x] 从 config 读 key/model/base_url

### 2.4 冒烟验证

- [ ] 写一个临时 `scripts/smoke.ts`（不进 build 产物）：
  - 加载一张本地测试图
  - 调 OpenAIProvider.analyze
  - 打印 description
- [ ] 用真实 `OPENAI_API_KEY` 跑通一次（或在无 key 时用 mock，至少保证代码路径不抛错）

## 验收

- 三种图片来源都能加载成统一形态
- OpenAI provider 能返回非空 description
- 接口设计干净，新增 Qwen/Kimi 只需实现 `VisionProvider`
