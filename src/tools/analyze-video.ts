/**
 * analyze_video 工具业务逻辑。
 *
 * 设计依据：docs/picsense-design.md §4.1、§4.3。
 *
 * 视频是独立输入形态，与图片并列。由于项目默认 provider（OpenAI Responses API）
 * 原生不支持视频，本工具通过抽帧把视频转成帧序列，复用图片管线发送给视觉模型。
 *
 * - 输入 video_source（URL/本地路径）+ prompt + 可选 session_id。
 * - 无 session_id → 抽帧创建 session；有 → 追加一轮（复用现有 appendTurn）。
 * - 返回 { session_id, summary, description }，与 analyze_images 一致。
 *
 * 抽帧在首轮一次性完成，后续轮次复用 session（帧作为首轮图片已挂载），
 * 不会重复抽帧——这与 SessionManager 的设计一致（图片只挂首轮）。
 */

import type { SessionManager } from '../core/session-manager.js';
import { loadVideo, type FrameOptions, VideoLoadError } from '../core/video-loader.js';
// 复用 analyze-images 的输入校验错误类型，保持一致语义。
import { ToolInputError } from './analyze-images.js';

export interface AnalyzeVideoParams {
  video_source?: string;
  prompt: string;
  session_id?: string;
}

export interface AnalyzeVideoResult {
  session_id: string;
  summary: string;
  description: string;
}

export { VideoLoadError };

/**
 * 执行视频识别（支持多轮迭代）。
 *
 * @param manager Session 管理器。
 * @param params 工具参数。
 * @param maxVideoBytes 单个视频字节上限。
 * @param frameOpts 抽帧选项（fps / maxFrames）。
 */
export async function analyzeVideo(
  manager: SessionManager,
  params: AnalyzeVideoParams,
  maxVideoBytes: number,
  frameOpts: FrameOptions,
): Promise<AnalyzeVideoResult> {
  if (typeof params.prompt !== 'string' || params.prompt.trim() === '') {
    throw new ToolInputError('prompt is required and must be a non-empty string.');
  }

  // 后续轮次（带 session_id）时，视频帧已在 session 内，无需再抽帧。
  if (params.session_id) {
    return manager.appendTurn(params.session_id, params.prompt);
  }

  // 首轮：必须有视频源。
  if (typeof params.video_source !== 'string' || params.video_source.trim() === '') {
    throw new ToolInputError('video_source is required when creating a new session.');
  }

  // 抽帧。
  const video = await loadVideo(params.video_source, maxVideoBytes, frameOpts);

  // 用抽出的帧创建 session（复用 createSessionWithImages，帧已加载无需再加载）。
  // displaySources 用原始视频引用（URL/路径），避免巨大的 base64 占用 list_sessions 展示。
  return manager.createSessionWithImages(video.frames, [video.source], params.prompt);
}

