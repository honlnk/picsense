# 07 · 协议补全：instructions 修复 + Chat Completions / Anthropic provider

> 状态：已完成（2026-09-29 结项，未提交——按用户惯例结项提交由用户决定）
> 关联：GitHub issue #3（Kimi 兼容：`/coding/v1/responses` 拒绝 input 中的 system 角色）
> 用户指令：修 Kimi bug；新增 Chat Completions 与 Anthropic 协议；实测分别用腾讯 API 与 DeepSeek；Kimi 已无额度、不实测。

## 一、背景

- issue #3：picsense 的 `openai` provider（Responses API）首轮在 `input` 数组里发 `role:'system'` 消息，Kimi 网关的 Responses 实现不接受该角色，首轮必 400。修复方式（issue 已附并本地验证）：把 system 提示改为请求体顶层 `instructions` 字段——对 OpenAI 官方语义等价，兼容面更大。
- 实测（2026-09-29，本会话）确认腾讯 Coding Copilot（`copilot.tencent.com/v2`）**没有** `/responses` 路由（404），只有 `/chat/completions` 且**强制流式**（非流式 400）；DeepSeek 官方提供 Anthropic 协议端点（`api.deepseek.com/anthropic`），且配了视觉模型 `deepseek-v4-flash-vision-exp`。
- 现状：`openai`（Responses）是唯一实现的 provider；`qwen`/`kimi` 仅有配置键位占位（配了会报 `Unknown provider`）。

## 二、已定决策（无开放选择题）

| 决策点 | 定稿 | 理由 |
|---|---|---|
| 新 provider 命名 | `chat`（env 前缀 `CHAT_`）、`anthropic`（env 前缀 `ANTHROPIC_`） | 与用户口径「Chat Completions 协议 / anthropic 协议」一致；不重命名既有 `openai`（避免破坏存量配置） |
| chat 流式 | **永远 `stream:true` + SSE 解析** | 腾讯强制流式；流式在所有 OpenAI 兼容端点通用，一套代码全覆盖 |
| anthropic 流式 | 非流式 | Anthropic/DeepSeek 的 anthropic 端点均支持非流式，实现最简 |
| anthropic `max_tokens` | 常量 8192 | Anthropic 协议必填字段；本轮不做可配置 |
| anthropic 图片 | URL 图片先下载转 base64（`source.type='base64'`） | Anthropic 协议只收 base64 图片块 |
| system 提示位置 | openai→顶层 `instructions`；chat→`messages[0]` 为 `role:'system'`；anthropic→顶层 `system` 字段 | 各协议的标准写法 |
| chat 的图片格式 | `{type:'image_url', image_url:{url}}`（嵌套形态，区别于 Responses 的扁平形态） | Chat Completions 标准 |
| Kimi 修复方式 | 按 issue #3 diff：提取 system → `instructions`，**删除**旧写法 | 不新旧并存 |
| 测试用腾讯端点 | 远程 `https://copilot.tencent.com/v2`（本地代理 18790 未运行，key 同源） | 唯一可测路径 |

## 三、阶段划分与门禁

每阶段门禁统一为：`pnpm typecheck` + `pnpm build` 全绿，再跑该阶段验收项。

| 阶段 | 内容 | 验收项 |
|---|---|---|
| S1 | `src/providers/openai.ts` 改 `instructions` | vibebabo 网关真实回归：`pnpm smoke --analyze`（首轮含 summary 生成，走新路径） |
| S2 | 新增 `src/providers/chat.ts`（含 SSE 解析）+ config/registry/env/README 同步 | 腾讯实测：`smoke --analyze` + `smoke:session`（多轮） |
| S3 | 新增 `src/providers/anthropic.ts`（含 URL→base64）+ 同步配置 | DeepSeek 实测：`smoke --analyze` + `smoke:session` |
| S4 | `pnpm e2e`（dist 全链路）+ 文档收尾 + 汇报 | e2e 4 项全过 |

## 四、验收点与降级方案

1. **typecheck / build / e2e**：无需 key，直接跑。
2. **vibebabo 回归**（S1）：用本地 MCP 配置里的 openai env（`gpt-5.6-sol` @ vibebabo）。验证 `instructions` 写法在真实 Responses 网关可用。
3. **腾讯 chat**（S2）：env `CHAT_API_KEY=<ZCode Tencent key>`、`CHAT_BASE_URL=https://copilot.tencent.com/v2`、`CHAT_MODEL=hy4-preview`。降级链：hy4-preview 图像不受支持 → 依次换 `glm-5.2`、`kimi-k3`。测试图用本地生成的纯色 PNG（64×64 红色），断言「描述提到红色」。
4. **DeepSeek anthropic**（S3）：env `ANTHROPIC_API_KEY=<ZCode DeepSeek key>`、`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_MODEL=deepseek-v4-flash-vision-exp`。降级：若端点拒收图片 → 记录「协议可用、DeepSeek 视觉受限」，如实汇报，**不擅自换端点**。
5. **Kimi 实测**：不做（无额度）。以 vibebabo 回归 + 协议语义论证代替，写入未验证清单。

## 五、明确不做（本期排除项)

- qwen / kimi 适配器（仍留占位，后续可基于 `chat` provider 收编）
- Kimi 端点实测（无额度）
- `chat` provider 的 URL→base64 下载（Kimi 专属限制，届时在 kimi 适配器做）
- anthropic 流式、`max_tokens` 可配置
- 版本号 bump、npm 发布、PR、issue #3 回帖（用户未要求）
- `docs/picsense-design.md` 回写（历史研究文档，保持原样）

## 六、新旧机制替代表

| 旧机制 | 去向 |
|---|---|
| openai provider 在 `input` 内发 system 消息 | **删除**，替换为顶层 `instructions` |
| registry 中 qwen/kimi 注释占位 | **保留**（仍为规划中） |
| `ProviderName`/`SUPPORTED_PROVIDERS` 三值 | **扩充**为五值（`+chat +anthropic`），不删旧值 |

## 七、迁移条款

无持久化数据（session 纯内存）。配置层面向后兼容：存量 `OPENAI_*` env 与 `DEFAULT_PROVIDER=openai` 不变；`instructions` 与原 system-in-input 在 OpenAI 官方语义等价，无需用户改动。

## 八、文档同步

- README：环境变量表（+chat/anthropic 行）、「API 格式」说明改为三协议并存、多 provider 配置示例。
- `.env.example`：新增两节。
- `docs/plan/00-master-plan.md`：阶段表追加 P7 行。
- 本文档：施工日志随门禁追加。

## 九、施工日志

- **2026-09-29 · S1 完成**：`openai.ts` system-in-input 已替换为顶层 `instructions`（`SUMMARY_INSTRUCTIONS` 常量 + `analyze()` 展开）。门禁 typecheck/build 绿；vibebabo 真实回归通过（`gpt-5.6-sol`，首轮 description + summary 均正常，红色测试图识别正确）。无偏差。
- **2026-09-29 · S2 完成**：新增 `src/providers/chat.ts`（永远流式 + SSE 解析）；config/registry 接线（`chat`）；新增 `scripts/smoke-multiturn.ts`（真实多轮测试脚本，补 mock 脚本不覆盖的多轮链路）。门禁 typecheck/build 绿（期间抓到并修复 `loadConfig` providers 字面量漏改）；腾讯实测通过：`hy4-preview` @ `copilot.tencent.com/v2`，首轮（红色图识别正确 + summary）与多轮追问（"What is the dominant color?" → "red"）均正常。无偏差，未动用降级链。
- **2026-09-29 · S3 完成**：新增 `src/providers/anthropic.ts`（非流式 + URL→base64 转码 + 顶层 system + 常量 max_tokens 8192）。门禁绿；DeepSeek 实测通过：`deepseek-v4-flash-vision-exp` @ `api.deepseek.com/anthropic`，首轮（识别 + summary）与多轮追问均正常，未动用降级方案（端点支持视觉）。
- **2026-09-29 · S4 完成**：`pnpm e2e` 全过（4 工具注册、参数校验、NDJSON）。文档同步：README（env 表 + 三协议说明 + 双示例）、`.env.example`、`00-master-plan.md`（P7 行）、`docs/index.html`（**计划外**：落地页 provider 矩阵描述已过时，3 处顺手同步——见偏差记录）。package.json 增加 `smoke:multiturn` 脚本入口。

### 偏差记录

1. **`docs/index.html` 计划外修改**：计划的文档同步清单漏列了落地页，但其中 3 处（特性列表、接入说明、API 格式 callout + env 表）明确声称"仅支持 Responses API"，与本轮交付直接矛盾，不同步即留错。已按事实更新。
2. **`package.json` 增加 `smoke:multiturn`**：计划只写了新增脚本文件，未写 package.json 入口；与其他 smoke:* 脚本保持一致，便于复用。

