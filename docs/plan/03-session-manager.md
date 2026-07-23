# P3：Session 管理器

> 依赖：P2
> 目标：实现多轮迭代的核心——Session 生命周期 + 并发隔离。
> 设计依据：设计文档 §4.2。

## Session 数据结构（`src/core/session-manager.ts`）

```typescript
interface Session {
  id: string;
  summary: string;
  imageSources: string[];     // 原始引用（用于 list_sessions 显示）
  messages: VisionMessage[];  // 发给视觉模型的完整多轮对话历史
  createdAt: number;
  lastAccessAt: number;
}
```

> **messages 布局（首轮 vs 后续）**：
> - 首轮：`[ {role:'user', content:'<含图>'} ]` → provider 把图拼进 content
> - 后续：push `{role:'assistant', content: 上轮description}` 再 push `{role:'user', content: 新prompt}`
>
> 注意：`Session.messages` 存的是 **文字层历史**，图片在调用 provider 时由 image-loader 重新加载并传入 `VisionRequest.images`。这样避免把 base64 大字符串长期驻留内存。provider 内部把首轮 user message 的 content 与 images 合并。

## 任务清单

- [ ] `createSession(imageSources, firstPrompt): Promise<{session, description, summary}>`
  - 生成 id（`crypto.randomUUID()`）
  - 加载图片 → 调 provider（generateSummary=true）
  - 初始化 messages：user(首prompt) + assistant(描述)
  - 写入 Map
- [ ] `appendTurn(sessionId, prompt): Promise<{description, summary}>`
  - 查 session，不存在抛错
  - 加锁（见 3.2）
  - messages 追加 user + 调 provider → 追加 assistant
  - 更新 lastAccessAt
- [ ] `listSessions(): SessionSnapshot[]`
  - 读快照（浅拷贝），计算 iteration = floor(messages.length / 2)
- [ ] 过期清理：定时器（每 1 小时）扫描，删除 `lastAccessAt + 24h < now` 的 session

### 3.2 并发隔离（设计文档 §4.2.4）

- [ ] `Map<sessionId, Mutex>`，每个 session 一把锁
- [ ] 最小可用锁实现：Promise 队列（无外部依赖）
  ```typescript
  class Mutex {
    private chain: Promise<void> = Promise.resolve();
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const run = this.chain.then(() => fn());
      this.chain = run.then(() => {}, () => {});
      return run;
    }
  }
  ```
- [ ] 同一 session 的请求串行；不同 session 并行
- [ ] 清理任务跳过正在使用的 session（锁被持有时跳过）

### 3.3 错误处理

- [ ] session_id 不存在 → 抛 `SessionNotFoundError`
- [ ] provider 调用失败 → 不修改 messages（事务性：append 失败不污染历史）

## 验收

- 创建 session 返回 id + summary
- 同一 id 多次 appendTurn，messages 正确累积
- 并发 appendTurn 同一 session 串行无冲突
- 24h 过期 session 被清理
