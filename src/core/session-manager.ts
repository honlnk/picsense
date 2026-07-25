/**
 * Session 管理器：多轮迭代的核心。
 *
 * 设计依据：docs/picsense-design.md §4.2、docs/plan/03-session-manager.md。
 *
 * 关键设计：
 * - Session.messages 只存「文字层历史」（不含 base64），图片在每次调 provider 时由
 *   image-loader 重新加载传入。避免大 base64 字符串长期驻留内存。
 * - 图片只在首轮 user message 挂载（provider 内部处理），后续轮次 messages 纯文字，
 *   拼成视觉模型的原生多轮 messages 数组。
 * - 同一 session 串行（session 级 Mutex），不同 session 并行。
 * - 过期 24h，每小时清理一次；进程退出即清空（纯内存态，不持久化）。
 * - appendTurn 事务性：provider 调用失败时不污染 messages 历史。
 */

import { randomUUID } from 'node:crypto';

import type { VisionMessage, VisionProvider } from '../providers/index.js';
import { loadImage, type LoadedImage } from './image-loader.js';

/** Session 内部结构。 */
export interface Session {
  readonly id: string;
  summary: string;
  /** 原始图片引用（用于 list_sessions 展示与按需重新加载）。 */
  imageSources: string[];
  /** 文字层多轮对话历史。 */
  messages: VisionMessage[];
  readonly createdAt: number;
  lastAccessAt: number;
}

/** list_sessions 对外暴露的快照形态。 */
export interface SessionSnapshot {
  readonly session_id: string;
  readonly summary: string;
  readonly image_sources: string[];
  readonly last_access_at: number;
  /** 已迭代轮数（user+assistant 各算一轮交互，floor(messages.length/2)）。 */
  readonly iteration: number;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * 极简 Mutex：基于 Promise 链串行化同一 session 的请求。
 * 参考 docs/plan/03-session-manager.md §3.2。
 */
class Mutex {
  private chain: Promise<void> = Promise.resolve();
  /** 是否正在被持有。清理任务据此跳过正在使用的 session。 */
  busy = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 创建/追加 session 的公共返回。 */
export interface TurnResult {
  readonly session_id: string;
  readonly summary: string;
  readonly description: string;
}

/**
 * Session 管理器。
 *
 * @param provider 视觉模型 provider。
 * @param maxImageBytes 单张图片字节上限（传给 image-loader）。
 * @param ttlMs session 过期时长（默认 24h）。
 * @param cleanupIntervalMs 清理任务执行间隔（默认 1h）。
 */
export class SessionManager {
  private readonly sessions = new Map<string, { session: Session; mutex: Mutex }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly provider: VisionProvider,
    private readonly maxImageBytes: number,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 60 * 60 * 1000,
  ) {}

  /** 启动定时清理任务。在 MCP server 启动时调用。 */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // 不阻止进程退出。
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** 停止清理任务。在 server 关闭时调用。 */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 扫描并删除过期 session（跳过正在使用的）。 */
  cleanup(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.mutex.busy) continue; // 设计文档 §4.2.4：跳过正在使用的
      if (now - entry.session.lastAccessAt > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 创建 session 并执行首轮识别。
   * 返回 session_id + summary + description。
   */
  async createSession(imageSources: string[], firstPrompt: string): Promise<TurnResult> {
    const id = randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      summary: '',
      imageSources: [...imageSources],
      messages: [],
      createdAt: now,
      lastAccessAt: now,
    };
    const mutex = new Mutex();
    this.sessions.set(id, { session, mutex });

    // 串行执行首轮（即便首轮无并发，也走锁以保持一致语义）。
    return mutex.run(() => this.executeFirstTurn(session, firstPrompt));
  }

  /**
   * 创建 session（传入已加载的图片），用于视频抽帧等场景——
   * 调用方已自行完成图片加载（如 ffmpeg 抽帧），无需走 image-loader 重新加载。
   *
   * @param images 已加载的图片帧（如视频抽出的帧序列）。
   * @param displaySources 用于 list_sessions 展示的来源引用（如视频 URL/路径，非完整 base64）。
   * @param firstPrompt 首轮 prompt。
   */
  async createSessionWithImages(
    images: LoadedImage[],
    displaySources: string[],
    firstPrompt: string,
  ): Promise<TurnResult> {
    const id = randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      summary: '',
      imageSources: [...displaySources],
      messages: [],
      createdAt: now,
      lastAccessAt: now,
    };
    const mutex = new Mutex();
    this.sessions.set(id, { session, mutex });

    return mutex.run(() => this.executeFirstTurnWithImages(session, images, firstPrompt));
  }

  /**
   * 在已有 session 上追加一轮提问。
   * session 不存在抛 SessionNotFoundError；provider 失败不污染 messages。
   */
  async appendTurn(sessionId: string, prompt: string): Promise<TurnResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    return entry.mutex.run(() => this.executeAppendTurn(entry.session, prompt));
  }

  /** 返回所有 session 的快照（浅拷贝，不阻塞写）。 */
  listSessions(): SessionSnapshot[] {
    const list: SessionSnapshot[] = [];
    for (const { session } of this.sessions.values()) {
      list.push(this.toSnapshot(session));
    }
    // 按 lastAccessAt 倒序，最近使用的在前。
    return list.sort((a, b) => b.last_access_at - a.last_access_at);
  }

  /** 当前 session 数量（调试/测试用）。 */
  get size(): number {
    return this.sessions.size;
  }

  private toSnapshot(session: Session): SessionSnapshot {
    return {
      session_id: session.id,
      summary: session.summary,
      image_sources: session.imageSources.map((s) => truncate(s, 80)),
      last_access_at: session.lastAccessAt,
      iteration: Math.floor(session.messages.length / 2),
    };
  }

  /** 首轮：加载图片 → 调 provider（带 summary）→ 写入 messages。 */
  private async executeFirstTurn(session: Session, firstPrompt: string): Promise<TurnResult> {
    const images: LoadedImage[] = [];
    for (const src of session.imageSources) {
      images.push(await loadImage(src, this.maxImageBytes));
    }
    return this.executeFirstTurnWithImages(session, images, firstPrompt);
  }

  /**
   * 首轮（图片已加载）：调 provider（带 summary）→ 写入 messages。
   * 抽取自 executeFirstTurn，供 createSessionWithImages 复用（视频抽帧等场景）。
   */
  private async executeFirstTurnWithImages(
    session: Session,
    images: LoadedImage[],
    firstPrompt: string,
  ): Promise<TurnResult> {
    // 调 provider：传入本轮 user prompt（图片由 provider 挂在首轮）。
    const reqMessages: VisionMessage[] = [{ role: 'user', content: firstPrompt }];
    const res = await this.provider.analyze({
      images,
      messages: reqMessages,
      generateSummary: true,
    });

    // 写入历史（事务：调用成功才落库）。
    session.messages.push(
      { role: 'user', content: firstPrompt },
      { role: 'assistant', content: res.description },
    );
    session.summary = res.summary ?? fallbackSummary(firstPrompt);
    session.lastAccessAt = Date.now();

    return {
      session_id: session.id,
      summary: session.summary,
      description: res.description,
    };
  }

  /** 后续轮：追加 user prompt → 调 provider（带完整历史，不带图）→ 追加 assistant。 */
  private async executeAppendTurn(session: Session, prompt: string): Promise<TurnResult> {
    // 构造发给 provider 的完整 messages：历史 + 本轮 prompt。
    const reqMessages: VisionMessage[] = [...session.messages, { role: 'user', content: prompt }];

    const res = await this.provider.analyze({
      images: [], // 后续轮不带图（图已在首轮）
      messages: reqMessages,
      generateSummary: false,
    });

    // 事务：成功才落库。
    session.messages.push(
      { role: 'user', content: prompt },
      { role: 'assistant', content: res.description },
    );
    session.lastAccessAt = Date.now();

    return {
      session_id: session.id,
      summary: session.summary,
      description: res.description,
    };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function fallbackSummary(firstPrompt: string): string {
  const trimmed = firstPrompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed || 'Vision session';
}
