/**
 * 图片加载：自动识别 http(s) URL / 本地文件路径 / base64，统一返回视觉模型可消费的形态。
 *
 * 设计依据：docs/picsense-design.md §5.3.5、§6.4。
 * - URL（含 ZCode 图床预签名 URL）：直传给视觉模型，不转 base64（避免无谓的带宽/内存开销）。
 * - 本地路径：读文件转 base64 data URL。
 * - base64 字符串：补全 data URL 前缀。
 * - 格式白名单：jpg / jpeg / png；单张 ≤ maxImageBytes（默认 5MB）。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 加载后的图片统一形态，直接塞进 OpenAI 兼容的 image_url.url 字段。 */
export interface LoadedImage {
  /** 直接可用于 image_url.url 的值：URL 或 data: base64 字符串。 */
  readonly url: string;
  /** MIME 类型，如 image/png。 */
  readonly mimeType: string;
  /** 来源类型，便于调试与报错。 */
  readonly sourceType: 'url' | 'file' | 'base64';
}

/** 支持的图片 MIME 白名单（与设计文档 §6.4 一致）。 */
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png']);

/** 扩展名 → MIME 映射。 */
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** 常见 base64 data URL 前缀。 */
const DATA_URL_RE = /^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

export class ImageLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageLoadError';
  }
}

function assertSupportedMime(mime: string, source: string): void {
  // 归一化：image/jpg 视作 image/jpeg 的别名。
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (!SUPPORTED_MIME.has(normalized)) {
    throw new ImageLoadError(
      `Unsupported image type "${mime}" from "${source}". Only jpg/jpeg/png are supported.`,
    );
  }
}

function assertSize(bytes: number, maxBytes: number, source: string): void {
  if (bytes > maxBytes) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw new ImageLoadError(
      `Image "${source}" is ${mb}MB, exceeds the ${maxMb}MB limit.`,
    );
  }
}

function mimeFromExt(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_MIME[ext];
}

/**
 * 判断来源形态并加载。
 *
 * @param source 原始图片引用（URL / 本地路径 / base64）。
 * @param maxBytes 单张图片字节上限。
 */
export async function loadImage(source: string, maxBytes: number): Promise<LoadedImage> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new ImageLoadError('Empty image source.');
  }

  // 1. http(s) URL —— 直传，不下载。
  if (/^https?:\/\//i.test(trimmed)) {
    // URL 的大小/格式无法在本地可靠校验（图床预签名 URL 不带稳定后缀），
    // 这里只做最低限度校验，真正的限制由视觉模型 API 侧把关。
    return { url: trimmed, mimeType: inferMimeFromUrl(trimmed), sourceType: 'url' };
  }

  // 2. data: base64 —— 已编码，补全校验。
  const dataUrlMatch = trimmed.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const [, mime, b64] = dataUrlMatch;
    assertSupportedMime(mime, trimmed.slice(0, 40));
    // base64 编码后每 4 字符约 3 字节。
    const approxBytes = Math.floor((b64.length * 3) / 4);
    assertSize(approxBytes, maxBytes, 'base64 image');
    return { url: trimmed, mimeType: normalizeMime(mime), sourceType: 'base64' };
  }

  // 3. 裸 base64 字符串（无 data: 前缀）—— 兜底，按 jpeg 推断（最常见），
  //    无法可靠判断真实格式，仅在确实拿到裸串时使用。
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 64) {
    const mime = 'image/jpeg';
    const approxBytes = Math.floor((trimmed.length * 3) / 4);
    assertSize(approxBytes, maxBytes, 'base64 image');
    return {
      url: `data:${mime};base64,${trimmed.replace(/\s/g, '')}`,
      mimeType: mime,
      sourceType: 'base64',
    };
  }

  // 4. 本地文件路径。
  return loadFromFile(trimmed, maxBytes);
}

async function loadFromFile(filePath: string, maxBytes: number): Promise<LoadedImage> {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    throw new ImageLoadError(`Image file not found or unreadable: "${filePath}".`);
  }

  if (!stats.isFile()) {
    throw new ImageLoadError(`Image path is not a file: "${filePath}".`);
  }
  assertSize(stats.size, maxBytes, filePath);

  const mime = mimeFromExt(filePath);
  if (!mime) {
    throw new ImageLoadError(
      `Cannot determine image type from path "${filePath}". Only jpg/jpeg/png are supported.`,
    );
  }
  assertSupportedMime(mime, filePath);

  const buf = await readFile(filePath);
  const b64 = buf.toString('base64');
  return {
    url: `data:${mime};base64,${b64}`,
    mimeType: mime,
    sourceType: 'file',
  };
}

/** 从 URL 路径推断 MIME，无法推断时返回 image/jpeg（视觉模型会自行解析）。 */
function inferMimeFromUrl(url: string): string {
  // 去掉 query/hash 后取扩展名。
  const clean = url.split('?')[0]?.split('#')[0] ?? url;
  const ext = path.extname(clean).slice(1).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'image/jpeg';
}

function normalizeMime(mime: string): string {
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}
