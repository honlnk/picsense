/**
 * Anthropic Messages API vision provider。
 *
 * 使用 Anthropic **Messages API**（POST {baseUrl}/v1/messages，非流式），
 * 适配 Anthropic 官方及一切 anthropic 协议兼容端点（如 DeepSeek 官方
 * api.deepseek.com/anthropic）。
 *
 * 协议要点：
 * - 鉴权走 `x-api-key` 头 + `anthropic-version`，不是 Bearer。
 * - `max_tokens` 为必填字段（常量 8192，本期不做可配置）。
 * - system 提示走顶层 `system` 字段（协议原生设计，无需 instructions 技巧）。
 * - 图片 content block 形态 `{type:'image', source:{type:'base64', media_type, data}}`——
 *   **只收 base64**，https URL 需先下载转码（见 toImageSource）。
 * - 响应 `content[]` 中 `type:'text'` 块的 text 为正文。
 *
 * baseUrl 规范化：不以 /v数字 结尾则补 /v1（api.anthropic.com → /v1/messages；
 * api.deepseek.com/anthropic → /anthropic/v1/messages）。
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

/** Anthropic Messages 的 content block。 */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Anthropic Messages 的 message。 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/** 首轮生成 summary 的系统指令（与 openai.ts 的 SUMMARY_INSTRUCTIONS 同文）。 */
const SUMMARY_SYSTEM_MESSAGE =
  'You are a vision assistant. After your description, append a one-sentence summary of this image session wrapped in <summary>...</summary> tags. The summary should capture the essence of what the user is analyzing.';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic 协议必填；长视频抽帧的描述长度也在这个量级内。 */
const MAX_TOKENS = 8192;

/** 规范化 baseUrl：确保以 /v1 结尾（路径为 /v1/messages）。 */
function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_BASE_URL;
  let url = raw.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(url)) {
    url += '/v1';
  }
  return url;
}

/** 把 LoadedImage 转成 Anthropic 的 base64 图片 source（必要时下载 URL）。 */
async function toImageSource(
  img: LoadedImage,
  timeoutMs: number,
): Promise<AnthropicContentBlock> {
  let mediaType = img.mimeType;
  let data: string;

  const dataPrefix = 'data:';
  if (img.url.startsWith(dataPrefix)) {
    // data:image/png;base64,xxx
    const commaIdx = img.url.indexOf(',');
    const meta = img.url.slice(dataPrefix.length, commaIdx);
    data = img.url.slice(commaIdx + 1).replace(/\s/g, '');
    const mime = meta.split(';')[0];
    if (mime) mediaType = mime;
  } else {
    // https URL：Anthropic 只收 base64，先下载转码。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(img.url, { signal: controller.signal });
      if (!res.ok) {
        throw new ProviderHttpError(
          `Failed to download image for anthropic provider: ${res.status} ${img.url.slice(0, 120)}`,
          res.status,
          '',
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.startsWith('image/')) {
        mediaType = contentType.split(';')[0];
      }
      data = buf.toString('base64');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  };
}

/**
 * 把 VisionRequest 转换为 Anthropic messages 数组。
 *
 * 规则：images 只附加到第一条 user 消息的 content（首轮）；system 提示由
 * analyze() 走顶层 system 字段，不进 messages。
 */
async function buildMessages(
  req: VisionRequest,
  timeoutMs: number,
): Promise<AnthropicMessage[]> {
  const messages: AnthropicMessage[] = [];

  let imagesAttached = false;
  for (const msg of req.messages) {
    if (msg.role === 'user' && req.images.length > 0 && !imagesAttached) {
      const parts: AnthropicContentBlock[] = [];
      for (const img of req.images) {
        parts.push(await toImageSource(img, timeoutMs));
      }
      parts.push({ type: 'text', text: msg.content });
      messages.push({ role: 'user', content: parts });
      imagesAttached = true;
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // 兜底：传了图片但 messages 里没有 user 消息（异常情况）。
  if (req.images.length > 0 && !imagesAttached) {
    const parts: AnthropicContentBlock[] = [];
    for (const img of req.images) {
      parts.push(await toImageSource(img, timeoutMs));
    }
    messages.push({ role: 'user', content: parts });
  }

  return messages;
}

/** 从 Messages API 返回中提取正文（content[] 里全部 text 块拼接）。 */
function extractText(data: unknown): string {
  const content = (
    data as { content?: Array<{ type?: string; text?: string }> }
  ).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
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

class AnthropicProvider implements VisionProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async analyze(req: VisionRequest): Promise<VisionResponse> {
    const messages = await buildMessages(req, this.timeoutMs);
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages,
      ...(req.generateSummary ? { system: SUMMARY_SYSTEM_MESSAGE } : {}),
    };

    const raw = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ProviderHttpError(
            `Anthropic Messages API error ${res.status}: ${text.slice(0, 500)}`,
            res.status,
            text,
          );
        }

        const data = await res.json();
        const content = extractText(data);
        if (!content) {
          throw new ProviderHttpError(
            'Anthropic Messages API returned no text content',
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
export const createAnthropicProvider: ProviderFactory = (cfg, opts: ProviderOpts) => {
  return new AnthropicProvider(
    cfg.apiKey,
    cfg.model,
    normalizeBaseUrl(cfg.baseUrl),
    opts.timeoutMs,
  );
};

// 模块加载时自注册。
registerProvider('anthropic', createAnthropicProvider);
