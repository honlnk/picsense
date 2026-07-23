# picsense

> 本地图片识别 MCP，让单模态基座模型获得多模态视觉能力。

`picsense` 是一款**本地安装**的 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）服务。它通过调用多模态视觉模型 API，让任何**单模态**基座模型（如 GLM-5.2 这类无法直接处理图片的模型）也能识别图片内容。

核心差异化：**支持多轮迭代识别**——基座模型可在处理任务的过程中多次调用，边干边查，逐步精修对图片的理解。

## 功能

三个工具，按输入形态划分（不按场景拆工具，把 prompt 控制权交给基座模型）：

| 工具 | 输入 | 用途 |
|------|------|------|
| `analyze_images` | 图片数组 + prompt + 可选 `session_id` | 图片识别 + 多轮迭代（核心工具；传一张是单图，传多张是批量/对比） |
| `list_sessions` | 无 | 查看当前所有识别会话的列表与简介 |
| `analyze_document` | 文档（URL / HTML / markdown） | 解析文档，识别其中所有图片，返回标注了图片描述的完整文档 |

### 多轮迭代识别

传统图片识别 MCP 是一次性的：给一张图 + 一个 prompt，返回描述，结束。但一次性描述往往不够详细或不够准确。

`picsense` 通过 session 机制支持多轮：

1. **首次调用** `analyze_images`（不传 `session_id`）→ 创建 session，返回描述 + `session_id`
2. 基座模型判断描述是否满足需求，**不满足则再次调用**（传入 `session_id`）→ 在已有对话基础上追加提问
3. 重复直到满足，基座模型基于最终描述继续处理任务

```
第 1 轮：analyze_images(图 + 初始 prompt) → description A + session_id
第 2 轮：analyze_images(session_id + "重点描述导航栏样式") → description B
... 直到满足 ...
```

> 这是「边干边查」的能力——基座模型在写代码过程中发现细节不清，可以随时重新读取图片的某个局部。

## 安装

需要 Node.js ≥ 20。

```bash
# 方式一：本地构建
git clone <repo-url> picsense
cd picsense
pnpm install
pnpm build
```

```bash
# 方式二：直接用 npx（发布后可用）
# npx picsense
```

## 配置

通过环境变量配置，代码内零硬编码。复制 `.env.example` 为 `.env` 并填入真实值：

```bash
cp .env.example .env
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `DEFAULT_PROVIDER` | 是 | `openai` | 默认 provider（`openai` / `qwen` / `kimi`） |
| `OPENAI_API_KEY` | 是* | — | OpenAI API Key（当 provider=openai 时必填） |
| `OPENAI_MODEL` | 是* | — | OpenAI 模型名（如 `gpt-5.6-sol`） |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | 自定义 base URL（代理或兼容网关）。会自动规范化：不带 `/v1` 则补上 |
| `MAX_IMAGE_MB` | 否 | `5` | 单张图片大小上限（MB） |
| `TIMEOUT_MS` | 否 | `300000` | 视觉模型请求超时（毫秒） |

\* 默认 provider 的 Key/Model 必填；其他 provider 仅在切换使用时才需要。

> **API 格式**：provider 使用 OpenAI **Responses API**（`/v1/responses` 原生格式），而非 Chat Completions。兼容任何实现了 Responses API 的网关。

### 多 provider 配置示例

**OpenAI（首版推荐）：**
```bash
DEFAULT_PROVIDER=openai
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-5.6-sol
```

**Qwen（后续支持） / Kimi（后续支持）：** 当前版本仅实现 OpenAI 适配器，Qwen 与 Kimi 适配器规划中。新增 provider 只需实现 `VisionProvider` 接口。

## 接入 ZCode

在 ZCode 的 MCP 配置中加入（其他 Agent 暂不考虑）：

```json
{
  "mcpServers": {
    "picsense": {
      "command": "node",
      "args": ["/path/to/picsense/dist/index.js"],
      "env": {
        "DEFAULT_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-xxx",
        "OPENAI_MODEL": "gpt-5.6-sol"
      }
    }
  }
}
```

> **单模态模型场景说明：** 在 ZCode + 单模态模型（如 GLM-5.2）下，用户粘贴的图片会被 ZCode 自动上传图床，以 **http URL** 形态到达 MCP 工具。`image_sources` 已设计为自动识别 URL / 本地路径 / base64，无需额外处理。

## 图片限制

- 格式：jpg / jpeg / png
- 单张大小：≤ 5MB

## 使用示例

**单图识别：**
```
analyze_images({
  image_sources: ["https://example.com/screenshot.png"],
  prompt: "描述这张 UI 截图的整体布局"
})
```

**多轮迭代——细化某个局部：**
```
// 第 2 轮（复用上一轮返回的 session_id）
analyze_images({
  session_id: "<上一轮返回的 session_id>",
  prompt: "重点描述导航栏的样式，包括颜色、间距、字体"
})
```

**多图对比：**
```
analyze_images({
  image_sources: ["https://example.com/expected.png", "https://example.com/actual.png"],
  prompt: "对比这两张图，找出差异"
})
```

**文档图片标注：**
```
analyze_document({
  document: "https://example.com/article-with-images"
})
// 返回标注了每张图片描述的完整文档
```

## 技术栈

- TypeScript + Node.js（stdio 本地 MCP）
- `@modelcontextprotocol/sdk` 官方 SDK
- 多 provider 架构（`VisionProvider` 接口）
- 零第三方 HTTP 库（仅用内置 fetch）

## 开发

```bash
pnpm install
pnpm build         # 编译
pnpm typecheck     # 类型检查
pnpm dev           # tsx watch 调试
pnpm smoke         # image-loader 冒烟（无需 API Key）
pnpm smoke:session # session-manager 单元测试（mock provider）
pnpm smoke:tools   # 三个工具逻辑测试（mock provider）
pnpm e2e           # 端到端 stdio 协议测试
```

## 许可证

Apache-2.0
