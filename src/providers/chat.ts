/**
 * OpenAI Chat Completions vision provider（通用协议适配器）。
 *
 * 使用 OpenAI **Chat Completions API**（POST {baseUrl}/chat/completions），
 * 适配一切实现了该协议的网关：腾讯 Coding Copilot（copilot.tencent.com/v2）、
 * DeepSeek 官方、Qwen 以及绝大多数 OpenAI 兼容网关。
 *
 * 与 Responses API provider（openai.ts）的区别：
 * - 请求用 messages 数组，content part 用 text / image_url（嵌套形态 image_url:{url}）。
 * - **永远 stream:true + SSE 解析**：腾讯端点强制流式（非流式直接 400），而流式
 *   在所有 OpenAI 兼容端点通用，一套实现全覆盖。
 * - 流式增量在 choices[0].delta.content；reasoning_content（思维链）不属于正文，忽略。
 *
 * baseUrl 规范化同 openai.ts：不以 /v数字 结尾则补 /v1（腾讯传 /v2 原样保留）。
 */

import type {
  ProviderFactory,
  ProviderOpts,
  VisionProvider,
  VisionRequest,
  VisionResponse,
} from './index.js';
import { registerProvider } from './index.js';
import { ProviderHttpError } from './openai.js';
import { withRetry } from './retry.js';
import type { LoadedImage } from '../core/image-loader.js';

/** Chat Completions 的 message。 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<ChatContentPart>;
}

/** Chat Completions 的 content part。 */
type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 首轮生成 summary 的系统指令（与 openai.ts 的 SUMMARY_INSTRUCTIONS 同文）。 */
const SUMMARY_SYSTEM_MESSAGE =
  'You are a vision assistant. After your description, append a one-sentence summary of this image session wrapped in <summary>...</summary> tags. The summary should capture the essence of what the user is analyzing.';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** 规范化 baseUrl：确保以 /v数字 结尾（路径为 /chat/completions）。 */
function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_BASE_URL;
  let url = raw.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(url)) {
    url += '/v1';
  }
  return url;
}

/**
 * 把 VisionRequest 转换为 messages 数组。
 *
 * 规则：images 只附加到 messages 里第一条 user 消息的 content（首轮）；
 * generateSummary 时在头部插入 system 消息（Chat Completions 的标准写法）。
 */
function buildMessages(req: VisionRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (req.generateSummary) {
    messages.push({ role: 'system', content: SUMMARY_SYSTEM_MESSAGE });
  }

  let imagesAttached = false;
  for (const msg of req.messages) {
    if (msg.role === 'user' && req.images.length > 0 && !imagesAttached) {
      const parts: ChatContentPart[] = req.images.map((img: LoadedImage) => ({
        type: 'image_url',
        image_url: { url: img.url },
      }));
      parts.push({ type: 'text', text: msg.content });
      messages.push({ role: 'user', content: parts });
      imagesAttached = true;
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // 兜底：传了图片但 messages 里没有 user 消息（异常情况）。
  if (req.images.length > 0 && !imagesAttached) {
    const parts: ChatContentPart[] = req.images.map((img) => ({
      type: 'image_url',
      image_url: { url: img.url },
    }));
    messages.push({ role: 'user', content: parts });
  }

  return messages;
}

/**
 * 消费 SSE 流，拼接 delta.content 为完整正文。
 *
 * 行格式 `data: {...}`，`data: [DONE]` 结束。流中携带 error 对象时抛
 * ProviderHttpError（status 500，纳入 withRetry 的可重试范围）。
 */
async function consumeSse(res: Response): Promise<string> {
  const body = res.body;
  if (!body) {
    throw new ProviderHttpError('Chat Completions stream has no body', res.status, '');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return text;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // 半行/噪音行，丢弃
      }
      const err = (chunk as { error?: unknown }).error;
      if (err) {
        throw new ProviderHttpError(
          `Chat Completions stream error: ${JSON.stringify(err).slice(0, 300)}`,
          500,
          JSON.stringify(err).slice(0, 500),
        );
      }
      const delta = (
        chunk as {
          choices?: Array<{ delta?: { content?: unknown } }>;
        }
      ).choices?.[0]?.delta?.content;
      if (typeof delta === 'string') {
        text += delta;
      }
    }
  }
  return text; // 流关闭但未见 [DONE]：返回已累积内容
}

/** 从模型回复中拆出 summary 和正文（与 openai.ts 同逻辑）。 */
function splitSummary(raw: string, expectSummary: boolean): { description: string; summary?: string } {
  if (!expectSummary) {
    return { description: raw };
  }
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) {
    const summary = match[1].trim();
    const description = raw.replace(match[0], '').trim();
    return { description: description || raw.trim(), summary };
  }
  const firstLine = raw.split('\n').find((l) => l.trim()) ?? raw.slice(0, 80);
  return { description: raw.trim(), summary: firstLine.trim().slice(0, 120) };
}

class ChatProvider implements VisionProvider {
  readonly name = 'chat';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async analyze(req: VisionRequest): Promise<VisionResponse> {
    const body = {
      model: this.model,
      messages: buildMessages(req),
      // 永远流式：腾讯端点强制要求，其余端点均兼容。
      stream: true,
    };

    const raw = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ProviderHttpError(
            `Chat Completions API error ${res.status}: ${text.slice(0, 500)}`,
            res.status,
            text,
          );
        }

        const content = await consumeSse(res);
        if (!content) {
          throw new ProviderHttpError(
            'Chat Completions API returned no text content',
            200,
            '',
          );
        }
        return { status: res.status, result: content };
      } finally {
        clearTimeout(timer);
      }
    });

    const { description, summary } = splitSummary(raw, req.generateSummary === true);
    return summary ? { description, summary } : { description };
  }
}

/** 工厂实现。 */
export const createChatProvider: ProviderFactory = (cfg, opts: ProviderOpts) => {
  return new ChatProvider(
    cfg.apiKey,
    cfg.model,
    normalizeBaseUrl(cfg.baseUrl),
    opts.timeoutMs,
  );
};

// 模块加载时自注册。
registerProvider('chat', createChatProvider);
