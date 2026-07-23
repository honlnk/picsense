/**
 * OpenAI Responses API vision provider。
 *
 * 该 provider 使用 OpenAI 的 **Responses API**（/v1/responses，原生格式），
 * 而非 Chat Completions API。区别：
 * - 请求用 input 数组（而非 messages），content part 用 input_text / input_image。
 * - 多图：首轮 user 的 content 数组里放多个 input_image + 一个 input_text。
 * - 图片字段 image_url：可为 https URL（直传）或 data:image/xxx;base64,...（base64）。
 * - 响应：output[].content[] 中 type=output_text 的 text 为正文。
 *
 * 调研确认（实测 vibebabo.com 网关 + gpt-5.6-sol）：
 * - endpoint: POST {baseUrl}/responses，其中 baseUrl 形如 https://api.openai.com/v1
 *   （若用户传入的 baseUrl 已带 /v1 则原样使用；若未带则补 /v1）。
 * - input 支持多轮：数组里多条 user/assistant 消息，assistant 的 content 用
 *   [{type:'output_text', text}] 形态（已在实测中验证多轮记忆）。
 *
 * 多轮对话布局（见 docs/plan/03-session-manager.md）：
 * 图片只挂在首轮 user message 的 content（input_image），后续轮次纯文字。
 */

import type {
  ProviderFactory,
  ProviderOpts,
  VisionProvider,
  VisionRequest,
  VisionResponse,
} from './index.js';
import { registerProvider } from './index.js';
import { withRetry } from './retry.js';

/** Responses API 的 input message。 */
interface ResponsesInputMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<ResponsesContentPart>;
}

/** Responses API 的 content part。 */
type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * 规范化 baseUrl：确保以 /v1 结尾（Responses API 路径为 /responses）。
 * - 用户传 https://api.openai.com → 补 /v1
 * - 用户传 https://api.openai.com/v1 → 原样
 * - 用户传 https://gateway.com/v1/ → 去尾斜杠
 */
function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_BASE_URL;
  let url = raw.replace(/\/+$/, ''); // 去尾斜杠
  if (!/\/v\d+$/.test(url)) {
    url += '/v1';
  }
  return url;
}

/**
 * 把 VisionRequest 转换为 Responses API 的 input 数组。
 *
 * 规则：images 只附加到 messages 里第一条 user 消息的 content（首轮）。
 */
function buildInput(req: VisionRequest): ResponsesInputMessage[] {
  const input: ResponsesInputMessage[] = [];

  // system 消息：仅当需要生成 summary 时，给一个极简结构指令。
  // 不预设场景化 prompt（设计文档 §2.3）。
  if (req.generateSummary) {
    input.push({
      role: 'system',
      content:
        'You are a vision assistant. After your description, append a one-sentence summary of this image session wrapped in <summary>...</summary> tags. The summary should capture the essence of what the user is analyzing.',
    });
  }

  let imagesAttached = false;
  for (const msg of req.messages) {
    if (msg.role === 'user' && req.images.length > 0 && !imagesAttached) {
      // 首条 user 消息：图片 + 文字。
      const parts: ResponsesContentPart[] = [];
      for (const img of req.images) {
        parts.push({ type: 'input_image', image_url: img.url });
      }
      parts.push({ type: 'input_text', text: msg.content });
      input.push({ role: 'user', content: parts });
      imagesAttached = true;
    } else {
      // user 后续轮：纯文字（用 input_text 包装，保持数组形态一致）。
      // assistant 历史轮：用 output_text 包装。
      const partType = msg.role === 'assistant' ? 'output_text' : 'input_text';
      input.push({
        role: msg.role,
        content: [{ type: partType, text: msg.content }],
      });
    }
  }

  // 兜底：传了图片但 messages 里没有 user 消息（异常情况）。
  if (req.images.length > 0 && !imagesAttached) {
    const parts: ResponsesContentPart[] = req.images.map((img) => ({
      type: 'input_image',
      image_url: img.url,
    }));
    input.push({ role: 'user', content: parts });
  }

  return input;
}

/** 从 Responses API 返回中拆出 summary 和正文 description。 */
function extractText(data: unknown): string {
  const out = (data as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }).output;
  if (!Array.isArray(out)) return '';
  const texts: string[] = [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && typeof c.text === 'string') {
          texts.push(c.text);
        }
      }
    }
  }
  return texts.join('\n').trim();
}

/** 从模型回复中拆出 summary 和正文 description。 */
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
  // 模型没按格式返回时，用首句兜底作 summary。
  const firstLine = raw.split('\n').find((l) => l.trim()) ?? raw.slice(0, 80);
  return { description: raw.trim(), summary: firstLine.trim().slice(0, 120) };
}

class OpenAIProvider implements VisionProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async analyze(req: VisionRequest): Promise<VisionResponse> {
    const input = buildInput(req);
    const body = {
      model: this.model,
      input,
      // 非流式，便于一次性拿到完整回复。
      stream: false,
    };

    const raw = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/responses`, {
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
            `OpenAI Responses API error ${res.status}: ${text.slice(0, 500)}`,
            res.status,
            text,
          );
        }

        const data = await res.json();
        const content = extractText(data);
        if (!content) {
          throw new ProviderHttpError(
            'OpenAI Responses API returned no text content',
            200,
            JSON.stringify(data).slice(0, 500),
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
export const createOpenAIProvider: ProviderFactory = (cfg, opts: ProviderOpts) => {
  return new OpenAIProvider(
    cfg.apiKey,
    cfg.model,
    normalizeBaseUrl(cfg.baseUrl),
    opts.timeoutMs,
  );
};

// 模块加载时自注册。
registerProvider('openai', createOpenAIProvider);
