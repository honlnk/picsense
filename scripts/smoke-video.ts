/**
 * 视频识别冒烟测试。
 *
 * 两层验证：
 * 1. video-loader：用 ffmpeg 生成一个真实测试视频 → 抽帧 → 验证帧数量与形态。
 * 2. analyze_video 工具：mock provider 验证参数校验、session 复用、多轮迭代。
 *
 * 运行：pnpm smoke:video
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

import { loadVideo, VideoLoadError } from '../src/core/video-loader.js';
import { analyzeVideo } from '../src/tools/analyze-video.js';
import { ToolInputError } from '../src/tools/analyze-images.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { VisionProvider, VisionRequest, VisionResponse } from '../src/providers/index.js';

/** mock provider：返回帧数信息便于断言。 */
class MockProvider implements VisionProvider {
  readonly name = 'mock';
  async analyze(req: VisionRequest): Promise<VisionResponse> {
    const n = req.images.length;
    const turns = req.messages.filter((m) => m.role === 'user').length;
    const description = `VIDEO_MOCK(${n} frames, turn ${turns})`;
    return req.generateSummary ? { description, summary: `video-summary-${turns}` } : { description };
  }
}

/** 用 ffmpeg 生成一个 3 秒的彩色测试视频（testsrc 源）。 */
function genTestVideo(outPath: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegStatic) {
      reject(new Error('ffmpeg-static unavailable'));
      return;
    }
    const args = [
      '-f', 'lavfi',
      '-i', `testsrc=duration=${seconds}:size=160x120:rate=10`,
      '-pix_fmt', 'yuv420p',
      '-y',
      '-loglevel', 'error',
      outPath,
    ];
    const proc = spawn(ffmpegStatic, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`gen video failed code=${code}: ${stderr}`)),
    );
  });
}

async function testVideoLoader(): Promise<void> {
  console.log('=== video-loader 测试（真实 ffmpeg 抽帧）===');
  if (!ffmpegStatic) throw new Error('ffmpeg-static 二进制不可用，无法测试');

  const dir = await mkdtemp(path.join(tmpdir(), 'picsense-smoke-'));
  const videoPath = path.join(dir, 'test.mp4');
  try {
    // 生成 3 秒测试视频（10fps 源 → 30 帧）。
    await genTestVideo(videoPath, 3);
    console.log('生成测试视频:', videoPath);

    // 1. 默认 1fps 抽帧，3 秒视频应抽 ~3 帧。
    const video = await loadVideo(videoPath, 100 * 1024 * 1024, { fps: 1, maxFrames: 30 });
    console.log('抽帧结果:', { frameCount: video.frameCount, firstFrameMime: video.frames[0]?.mimeType });
    if (video.frameCount === 0) throw new Error('应至少抽出 1 帧');
    if (video.frameCount < 2 || video.frameCount > 4) {
      throw new Error(`3秒视频@1fps 应抽 2-4 帧，实际 ${video.frameCount}`);
    }
    if (!video.frames.every((f) => f.mimeType === 'image/jpeg')) {
      throw new Error('所有帧应为 image/jpeg');
    }
    if (!video.frames.every((f) => f.url.startsWith('data:image/jpeg;base64,'))) {
      throw new Error('所有帧 url 应为 base64 data URL');
    }

    // 2. maxFrames 限制：即使视频更长也最多抽 N 帧。
    const capped = await loadVideo(videoPath, 100 * 1024 * 1024, { fps: 10, maxFrames: 5 });
    console.log('maxFrames=5 抽帧:', capped.frameCount);
    if (capped.frameCount > 5) throw new Error(`maxFrames=5 应至多 5 帧，实际 ${capped.frameCount}`);

    // 3. 不存在的文件应报错。
    let threw = false;
    try {
      await loadVideo(path.join(dir, 'nope.mp4'), 100 * 1024 * 1024, { fps: 1, maxFrames: 30 });
    } catch (e) {
      threw = e instanceof VideoLoadError;
    }
    if (!threw) throw new Error('不存在的视频应抛 VideoLoadError');

    // 4. 超大文件上限（伪造一个小上限）。
    threw = false;
    try {
      await loadVideo(videoPath, 1, { fps: 1, maxFrames: 30 });
    } catch (e) {
      threw = e instanceof VideoLoadError;
    }
    if (!threw) throw new Error('超上限视频应抛 VideoLoadError');

    console.log('=== video-loader 测试通过 ===\n');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function testAnalyzeVideoTool(): Promise<void> {
  console.log('=== analyze_video 工具测试（mock provider）===');
  const mgr = new SessionManager(new MockProvider(), 5 * 1024 * 1024);

  // 1. 空 prompt 应抛 ToolInputError。
  let threw = false;
  try {
    await analyzeVideo(mgr, { video_source: 'x', prompt: '   ' }, 100 * 1024 * 1024, { fps: 1, maxFrames: 30 });
  } catch (e) {
    threw = e instanceof ToolInputError;
  }
  if (!threw) throw new Error('空 prompt 应抛 ToolInputError');

  // 2. 首轮无 video_source 应抛 ToolInputError。
  threw = false;
  try {
    await analyzeVideo(mgr, { prompt: '描述视频' }, 100 * 1024 * 1024, { fps: 1, maxFrames: 30 });
  } catch (e) {
    threw = e instanceof ToolInputError;
  }
  if (!threw) throw new Error('首轮无 video_source 应抛 ToolInputError');

  // 3. session_id 指向不存在的 session：直接走 appendTurn，session 不存在应抛 SessionNotFoundError。
  threw = false;
  try {
    await analyzeVideo(
      mgr,
      { session_id: 'nonexistent', prompt: '继续' },
      100 * 1024 * 1024,
      { fps: 1, maxFrames: 30 },
    );
  } catch (e) {
    threw = e instanceof Error && e.name === 'SessionNotFoundError';
  }
  if (!threw) throw new Error('不存在的 session_id 应抛 SessionNotFoundError');

  console.log('参数校验: OK');

  // 4. 端到端：用真实测试视频走 analyzeVideo（mock provider）。
  if (ffmpegStatic) {
    const dir = await mkdtemp(path.join(tmpdir(), 'picsense-smoke-'));
    const videoPath = path.join(dir, 'test.mp4');
    try {
      await genTestVideo(videoPath, 2);
      const r1 = await analyzeVideo(mgr, { video_source: videoPath, prompt: '描述视频内容' }, 100 * 1024 * 1024, {
        fps: 1,
        maxFrames: 30,
      });
      console.log('首轮:', { summary: r1.summary, desc: r1.description });
      if (!r1.session_id) throw new Error('应返回 session_id');
      if (!r1.description.includes('frames')) throw new Error('首轮描述应含帧数');

      // 5. 多轮迭代：复用 session，不重新抽帧。
      const r2 = await analyzeVideo(mgr, { session_id: r1.session_id, prompt: '细看第 1 秒' }, 100 * 1024 * 1024, {
        fps: 1,
        maxFrames: 30,
      });
      console.log('多轮:', { desc: r2.description, sameSession: r2.session_id === r1.session_id });
      if (r2.session_id !== r1.session_id) throw new Error('应复用同一 session');
      if (!r2.description.includes('turn 2')) throw new Error('第二轮应是第 2 轮');

      // 6. list_sessions 显示原始视频路径（非 base64）。
      const list = mgr.listSessions();
      const entry = list[0];
      console.log('list entry:', { summary: entry?.summary, image_sources: entry?.image_sources });
      if (entry && entry.image_sources.some((s) => s.includes('base64'))) {
        throw new Error('list_sessions 不应展示 base64 帧，应展示原始视频路径');
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    console.log('（跳过端到端：ffmpeg-static 不可用）');
  }

  console.log('=== analyze_video 工具测试通过 ===\n');
}

async function main(): Promise<void> {
  await testVideoLoader();
  await testAnalyzeVideoTool();
  console.log('✅ 视频识别全部测试通过');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
