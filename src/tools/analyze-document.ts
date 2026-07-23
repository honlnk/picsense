/**
 * analyze_document 工具业务逻辑。
 *
 * 设计依据：docs/picsense-design.md §4.1、§4.2.5。
 * - 输入文档（URL/HTML/markdown 自动识别）。
 * - 识别其中所有图片，在图片位置旁标注描述。
 * - 返回标注后的完整文档 + 识别图片数。
 *
 * 职责单一：输入文档、输出文档。识别 prompt 内置，不接收外部 prompt（§4.2.5）。
 * 标注格式：图片后插入注释，不破坏原文档渲染：
 *   markdown: ![alt](url)\n<!-- image-vision: <desc> -->
 *   html:     <img src="url"> 后插 <!-- image-vision: <desc> -->
 *
 * 策略：逐张串行识别（保守，避免 rate limit）。失败容错，原图保留并标注失败原因。
 */

import type { VisionProvider } from '../providers/index.js';
import { loadImage, type LoadedImage, ImageLoadError } from '../core/image-loader.js';

export interface AnalyzeDocumentParams {
  document: string;
}

export interface AnalyzeDocumentResult {
  document: string;
  images_analyzed: number;
}

/** 内置识别 prompt（不接收外部 prompt）。 */
const DOC_IMAGE_PROMPT = 'Describe this image concisely and accurately.';

const HTML_IMG_RE = /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
const MD_IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export class DocumentFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentFetchError';
  }
}

export async function analyzeDocument(
  provider: VisionProvider,
  maxImageBytes: number,
  timeoutMs: number,
  params: AnalyzeDocumentParams,
): Promise<AnalyzeDocumentResult> {
  const doc = params.document?.trim();
  if (!doc) {
    return { document: params.document ?? '', images_analyzed: 0 };
  }

  // 自动识别文档形态：URL → 抓取；含 <img → HTML；否则 markdown。
  let content = doc;
  let isHtml = /<[a-z!][\s\S]*>/i.test(doc);
  if (/^https?:\/\//i.test(doc)) {
    content = await fetchDocument(doc, timeoutMs);
    // 抓回来的内容形态重新判断。
    isHtml = /<[a-z!][\s\S]*>/i.test(content) && /<img\s/i.test(content);
  }

  if (isHtml) {
    return annotateHtml(provider, maxImageBytes, content);
  }
  return annotateMarkdown(provider, maxImageBytes, content);
}

/** 抓取 URL 文档正文。 */
async function fetchDocument(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html, text/markdown, text/plain, */*' },
    });
    if (!res.ok) {
      throw new DocumentFetchError(`Failed to fetch document: HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 标注 HTML 文档中的 <img>。 */
async function annotateHtml(
  provider: VisionProvider,
  maxImageBytes: number,
  html: string,
): Promise<AnalyzeDocumentResult> {
  const matches: Array<{ src: string; index: number; fullEnd: number }> = [];
  let m: RegExpExecArray | null;
  HTML_IMG_RE.lastIndex = 0;
  while ((m = HTML_IMG_RE.exec(html)) !== null) {
    matches.push({ src: m[1]!, index: m.index, fullEnd: m.index + m[0].length });
  }

  if (matches.length === 0) return { document: html, images_analyzed: 0 };

  // 从后往前插入注释，避免影响前面的 index。
  let result = html;
  let analyzed = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { src, fullEnd } = matches[i]!;
    const desc = await recognizeOne(provider, maxImageBytes, src);
    const comment = `\n<!-- image-vision: ${escapeComment(desc)} -->`;
    result = result.slice(0, fullEnd) + comment + result.slice(fullEnd);
    if (!desc.startsWith('[识别失败')) analyzed++;
  }
  return { document: result, images_analyzed: analyzed };
}

/** 标注 markdown 文档中的 ![]()。 */
async function annotateMarkdown(
  provider: VisionProvider,
  maxImageBytes: number,
  md: string,
): Promise<AnalyzeDocumentResult> {
  const matches: Array<{ full: string; index: number; end: number }> = [];
  let m: RegExpExecArray | null;
  MD_IMG_RE.lastIndex = 0;
  while ((m = MD_IMG_RE.exec(md)) !== null) {
    matches.push({ full: m[0], index: m.index, end: m.index + m[0].length });
  }

  if (matches.length === 0) return { document: md, images_analyzed: 0 };

  let result = md;
  let analyzed = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    // 提取 url：full 形如 ![alt](url)
    const urlMatch = matches[i]!.full.match(/!\[[^\]]*\]\(([^)]+)\)/);
    const url = urlMatch ? urlMatch[1]!.trim() : '';
    const desc = await recognizeOne(provider, maxImageBytes, url);
    const comment = `\n<!-- image-vision: ${escapeComment(desc)} -->`;
    result = result.slice(0, matches[i]!.end) + comment + result.slice(matches[i]!.end);
    if (!desc.startsWith('[识别失败')) analyzed++;
  }
  return { document: result, images_analyzed: analyzed };
}

/** 识别单张图，失败返回错误占位（不抛出，保证整体流程继续）。 */
async function recognizeOne(
  provider: VisionProvider,
  maxImageBytes: number,
  src: string,
): Promise<string> {
  try {
    const img: LoadedImage = await loadImage(src, maxImageBytes);
    const res = await provider.analyze({
      images: [img],
      messages: [{ role: 'user', content: DOC_IMAGE_PROMPT }],
      generateSummary: false,
    });
    return res.description;
  } catch (err) {
    const reason =
      err instanceof ImageLoadError ? err.message : err instanceof Error ? err.message : String(err);
    return `[识别失败: ${reason}]`;
  }
}

/** 转义注释内容中的 -->，避免破坏 HTML 注释。 */
function escapeComment(s: string): string {
  return s.replace(/-->/g, '--&gt;');
}
