/**
 * 视频加载：把视频解码成帧序列，复用图片管线发送给视觉模型。
 *
 * 设计依据：docs/picsense-design.md §4.3。
 *
 * 为什么抽帧而非直传视频：
 * 项目默认 provider 是 OpenAI Responses API，该 API **原生不支持视频**
 * （只有 input_text / input_image / input_file，无 input_video）。
 * OpenAI 官方视频理解方案就是抽帧——用 ffmpeg 把视频解码成 N 张 JPEG，
 * 作为多个 input_image 发送（参考 OpenAI Cookbook）。
 *
 * 抽帧使用 ffmpeg-static（npm 包，自带跨平台 ffmpeg 二进制，无需系统安装），
 * 契合本项目「零外部依赖」理念。URL 视频先下载到临时文件再抽帧。
 *
 * 抽出的帧作为 LoadedImage 返回（jpeg），复用现有 image-loader 的校验逻辑，
 * 下游 provider / session-manager 完全不感知「视频」概念——它们看到的就是多张图。
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ffmpeg-static 默认导出 ffmpeg 二进制的绝对路径（跨平台自带）。
import ffmpegStatic from 'ffmpeg-static';

import type { LoadedImage } from './image-loader.js';

/** 抽帧选项。 */
export interface FrameOptions {
  /** 采样率（每秒抽几帧），默认 1。 */
  fps: number;
  /** 最大抽帧数，默认 30。 */
  maxFrames: number;
}

/** 加载视频的结果：抽出的一组帧（复用 LoadedImage 形态）。 */
export interface LoadedVideo {
  /** 抽出的帧序列，按时间顺序。 */
  readonly frames: LoadedImage[];
  /** 抽出的帧数。 */
  readonly frameCount: number;
  /** 原始视频引用（URL 或本地路径），用于 list_sessions 展示。 */
  readonly source: string;
}

export class VideoLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoLoadError';
  }
}

/** 支持的视频扩展名白名单（URL 不做强校验，交 ffmpeg 判断）。 */
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'wmv', 'webm', 'mkv', 'flv', 'mpeg', 'mpg']);

/**
 * 解析 ffmpeg 可执行文件路径。
 *
 * 解析顺序：
 * 1. ffmpeg-static 自带二进制（npm 安装时由其 install 脚本下载）—— 检查文件存在。
 * 2. 系统 ffmpeg（用户自行安装的 brew/apt/官网版本）—— 通过 which/where 查找。
 *
 * 解决场景：--ignore-scripts / 企业内网代理导致 ffmpeg-static 的 install 脚本
 * 未执行、二进制缺失时，只要用户系统装了 ffmpeg 仍可正常工作。
 *
 * 两者都不可用时抛 VideoLoadError，提示用户安装。
 */
async function resolveFfmpeg(): Promise<string> {
  // 1. ffmpeg-static 自带二进制（install 脚本执行过才存在）。
  if (ffmpegStatic) {
    try {
      const stats = await stat(ffmpegStatic);
      if (stats.isFile()) return ffmpegStatic;
    } catch {
      // 文件不存在，继续 fallback。
    }
  }

  // 2. 系统 ffmpeg。
  const systemFfmpeg = await whichSystem('ffmpeg');
  if (systemFfmpeg) return systemFfmpeg;

  throw new VideoLoadError(
    'ffmpeg is required for video recognition but was not found. ' +
      'The bundled ffmpeg-static binary is missing (its install script may have been skipped, ' +
      'e.g. under --ignore-scripts or a restricted network), and no system ffmpeg was detected. ' +
      'Please install ffmpeg (e.g. `brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu) ' +
      'or reinstall this package without --ignore-scripts.',
  );
}

/**
 * 在 PATH 中查找可执行文件（跨平台）。
 * Unix 用 which，Windows 用 where。找不到返回 undefined（不抛错）。
 */
async function whichSystem(bin: string): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    const proc = spawn(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.on('error', () => resolve(undefined));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      // which/where 可能返回多行（多个匹配），取第一个。
      const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      resolve(first);
    });
  });
}

/**
 * 判断来源形态并加载视频。
 *
 * @param source 原始视频引用（URL / 本地路径）。
 * @param maxBytes 单个视频字节上限。
 * @param opts 抽帧选项。
 */
export async function loadVideo(
  source: string,
  maxBytes: number,
  opts: FrameOptions,
): Promise<LoadedVideo> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new VideoLoadError('Empty video source.');
  }

  // 解析 ffmpeg 路径：优先 ffmpeg-static 自带二进制，失败则 fallback 系统 ffmpeg。
  // 解决场景：--ignore-scripts / 企业内网导致 ffmpeg-static install 脚本未执行、
  // 二进制缺失时，只要用户系统装了 ffmpeg（brew/apt/官网）仍可工作。
  const ffmpegBin = await resolveFfmpeg();

  // 临时工作目录：下载 / 抽帧都在这里，用完即删。
  const workDir = path.join(os.tmpdir(), `picsense-video-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    let videoPath: string;

    if (/^https?:\/\//i.test(trimmed)) {
      // URL：下载到临时文件（OpenAI 无法消费视频 URL，必须本地抽帧）。
      videoPath = await downloadVideo(trimmed, maxBytes, workDir);
    } else {
      // 本地路径：校验存在性、类型、大小。
      videoPath = await validateLocalVideo(trimmed, maxBytes);
    }

    // 抽帧。
    const frames = await extractFrames(ffmpegBin, videoPath, workDir, opts);
    if (frames.length === 0) {
      throw new VideoLoadError(
        `Failed to extract any frames from "${trimmed}". The file may not be a valid video or is corrupted.`,
      );
    }

    return {
      frames,
      frameCount: frames.length,
      source: trimmed,
    };
  } finally {
    // 无论成功失败都清理临时目录。
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 校验本地视频文件：存在性、扩展名、大小。 */
async function validateLocalVideo(filePath: string, maxBytes: number): Promise<string> {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    throw new VideoLoadError(`Video file not found or unreadable: "${filePath}".`);
  }
  if (!stats.isFile()) {
    throw new VideoLoadError(`Video path is not a file: "${filePath}".`);
  }
  if (stats.size > maxBytes) {
    const mb = (stats.size / 1024 / 1024).toFixed(1);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw new VideoLoadError(`Video "${filePath}" is ${mb}MB, exceeds the ${maxMb}MB limit.`);
  }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext && !VIDEO_EXTS.has(ext)) {
    throw new VideoLoadError(
      `Unsupported video type ".${ext}" from "${filePath}". Supported: ${[...VIDEO_EXTS].join(', ')}.`,
    );
  }
  return filePath;
}

/** 下载 URL 视频到临时文件，带大小上限校验（流式，超限即中止）。 */
async function downloadVideo(url: string, maxBytes: number, workDir: string): Promise<string> {
  const controller = new AbortController();
  // 下载单独留一个较短超时（视频可能较大）。
  const timer = setTimeout(() => controller.abort(), 120000);
  const outPath = path.join(workDir, `source${path.extname(new URL(url).pathname) || '.mp4'}`);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'video/*, */*' },
    });
    if (!res.ok || !res.body) {
      throw new VideoLoadError(`Failed to download video: HTTP ${res.status} from "${url}".`);
    }

    // 流式写入：边写边计大小，超限即中止。
    const file = await writeFileStream(res.body, outPath, maxBytes, url);
    return file;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 ReadableStream 流式写入文件，超 maxBytes 即中止抛错。 */
async function writeFileStream(
  stream: ReadableStream<Uint8Array>,
  outPath: string,
  maxBytes: number,
  sourceUrl: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const mb = (total / 1024 / 1024).toFixed(1);
      const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
      throw new VideoLoadError(
        `Video from "${sourceUrl}" exceeds ${maxMb}MB limit (reached ${mb}MB during download).`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  await writeFile(outPath, Buffer.concat(chunks));
  return outPath;
}

/**
 * 调用 ffmpeg 抽帧。
 *
 * 参数：-i <input> -vf fps=<fps> -frames:v <max> -q:v 2 <out>/frame_%05d.jpg
 * - fps=N：每秒抽 N 帧
 * - -frames:v=N：最多抽 N 帧
 * - -q:v 2：JPEG 质量（2 为高质量）
 */
async function extractFrames(
  ffmpegBin: string,
  videoPath: string,
  workDir: string,
  opts: FrameOptions,
): Promise<LoadedImage[]> {
  const frameDir = path.join(workDir, 'frames');
  await mkdir(frameDir, { recursive: true });
  const pattern = path.join(frameDir, 'frame_%05d.jpg');

  const args = [
    '-i', videoPath,
    '-vf', `fps=${opts.fps}`,
    '-frames:v', String(opts.maxFrames),
    '-q:v', '2',
    pattern,
    '-y', // 覆盖输出
    '-loglevel', 'error',
  ];

  await runFfmpeg(ffmpegBin, args);

  // 读取抽出的帧（按文件名排序保证时间顺序）。
  const files = (await readdir(frameDir))
    .filter((f) => f.endsWith('.jpg'))
    .sort();
  const frames: LoadedImage[] = [];
  for (const f of files) {
    const buf = await readFile(path.join(frameDir, f));
    const b64 = buf.toString('base64');
    frames.push({
      url: `data:image/jpeg;base64,${b64}`,
      mimeType: 'image/jpeg',
      // sourceType 标记为 file，语义上是「来自本地视频文件的帧」。
      sourceType: 'file',
    });
  }
  return frames;
}

/** spawn ffmpeg，等待退出；非零退出码抛 VideoLoadError。 */
function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(new VideoLoadError(`Failed to start ffmpeg: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim().slice(0, 500);
        reject(
          new VideoLoadError(
            `ffmpeg exited with code ${code}${detail ? `: ${detail}` : '.'}`,
          ),
        );
      }
    });
  });
}
