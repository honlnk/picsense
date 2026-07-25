/**
 * analyze_images 工具业务逻辑。
 *
 * 设计依据：docs/picsense-design.md §4.1、§4.2.5。
 * - 输入 image_sources（URL/路径/base64 自动识别）+ prompt + 可选 session_id。
 * - 无 session_id → 创建 session；有 → 追加一轮。
 * - 返回 { session_id, summary, description }。
 *
 * 本函数是纯业务，不涉及 MCP 注册（那在 P5）。
 */

import type { SessionManager } from '../core/session-manager.js';

export interface AnalyzeImagesParams {
  image_sources?: string[];
  prompt: string;
  session_id?: string;
}

export interface AnalyzeImagesResult {
  session_id: string;
  summary: string;
  description: string;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * 执行图片识别（支持多轮迭代）。
 *
 * 注意：首次调用时 image_sources 必填；传入已有 session_id 时，
 * 沿用该 session 的图片，image_sources 会被忽略。
 */
export async function analyzeImages(
  manager: SessionManager,
  params: AnalyzeImagesParams,
): Promise<AnalyzeImagesResult> {
  if (typeof params.prompt !== 'string' || params.prompt.trim() === '') {
    throw new ToolInputError('prompt is required and must be a non-empty string.');
  }

  // 后续轮次（带 session_id）时，图片已在 session 内，不需要再传。
  if (params.session_id) {
    return manager.appendTurn(params.session_id, params.prompt);
  }

  // 首轮：必须有图片。
  if (!Array.isArray(params.image_sources) || params.image_sources.length === 0) {
    throw new ToolInputError(
      'image_sources is required (with at least one image) when creating a new session.',
    );
  }

  return manager.createSession(params.image_sources, params.prompt);
}
