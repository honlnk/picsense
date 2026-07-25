/**
 * P2 冒烟脚本（不进 build 产物，scripts/ 已在 tsconfig exclude 中）。
 *
 * 用法：
 *   pnpm smoke                    # 仅测试 image-loader（无需 API Key）
 *   pnpm smoke --analyze <path>   # 真实调 OpenAI 识别一张图（需 OPENAI_API_KEY）
 *
 * 这个脚本走 src 源码（tsx），验证图片加载与 provider 组装逻辑。
 */

import { loadImage } from '../src/core/image-loader.js';
import { loadConfig } from '../src/utils/config.js';
import { getProvider } from '../src/providers/registry.js'; // 同时触发 provider 自注册
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function testImageLoader(): Promise<void> {
  console.log('=== image-loader 测试 ===');

  // 造一张极小的 PNG（1x1 红点）用于文件路径测试。
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
  const tmpPath = path.join(fileURLToPath(new URL('.', import.meta.url)), '_smoke_test.png');
  await writeFile(tmpPath, tinyPng);

  const config = loadConfig({ OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'fake' });

  // 1. 本地文件路径
  const fromFile = await loadImage(tmpPath, config.maxImageBytes);
  console.log('[file]   ', { sourceType: fromFile.sourceType, mimeType: fromFile.mimeType, urlPrefix: fromFile.url.slice(0, 30) });

  // 2. base64 data URL
  const b64 = `data:image/png;base64,${tinyPng.toString('base64')}`;
  const fromB64 = await loadImage(b64, config.maxImageBytes);
  console.log('[base64] ', { sourceType: fromB64.sourceType, mimeType: fromB64.mimeType });

  // 3. URL
  const fromUrl = await loadImage('https://example.com/photo.jpg', config.maxImageBytes);
  console.log('[url]    ', { sourceType: fromUrl.sourceType, mimeType: fromUrl.mimeType, url: fromUrl.url });

  // 4. 本地不支持格式（.webp 文件）应报错；URL 不做格式强校验（交模型侧把关）
  try {
    await loadImage(tmpPath.replace('.png', '.webp'), config.maxImageBytes);
    console.log('[webp file] 预期报错但未报错 ❌');
  } catch (e) {
    console.log('[webp file] 正确拒绝 ✅→', (e as Error).message.slice(0, 50));
  }

  console.log('=== image-loader 测试通过 ===\n');
}

async function testAnalyze(imagePath: string): Promise<void> {
  console.log('=== provider 真实识别测试 ===');
  const config = loadConfig(); // 读真实环境变量
  const providerCfg = config.providers[config.defaultProvider];
  if (!providerCfg) throw new Error(`provider ${config.defaultProvider} 未配置`);
  const provider = getProvider(config.defaultProvider, providerCfg, { timeoutMs: config.timeoutMs });

  const images = [await loadImage(imagePath, config.maxImageBytes)];
  const res = await provider.analyze({
    images,
    messages: [{ role: 'user', content: 'Describe this image concisely.' }],
    generateSummary: true,
  });
  console.log('description:', res.description);
  console.log('summary:    ', res.summary);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const analyzeIdx = args.indexOf('--analyze');
  if (analyzeIdx !== -1 && args[analyzeIdx + 1]) {
    await testAnalyze(args[analyzeIdx + 1]!);
  } else {
    await testImageLoader();
  }
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
