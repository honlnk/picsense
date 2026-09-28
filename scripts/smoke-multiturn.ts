/**
 * 真实 provider 多轮对话测试（需要对应 provider 的 API Key）。
 *
 * 验证：首轮（带图 + generateSummary）→ 追问轮（纯文字 + 完整历史）。
 * 与 smoke --analyze 的区别：走两轮，覆盖多轮 messages 组装路径。
 *
 * 运行：tsx scripts/smoke-multiturn.ts <image-path>
 */

import { loadImage } from '../src/core/image-loader.js';
import { loadConfig } from '../src/utils/config.js';
import { getProvider } from '../src/providers/registry.js'; // 同时触发 provider 自注册

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) throw new Error('用法: tsx scripts/smoke-multiturn.ts <image-path>');

  const config = loadConfig();
  const providerCfg = config.providers[config.defaultProvider];
  if (!providerCfg) throw new Error(`provider ${config.defaultProvider} 未配置`);
  const provider = getProvider(config.defaultProvider, providerCfg, {
    timeoutMs: config.timeoutMs,
  });

  const images = [await loadImage(imagePath, config.maxImageBytes)];

  console.log('=== 第一轮（带图 + summary）===');
  const first = await provider.analyze({
    images,
    messages: [{ role: 'user', content: 'Describe this image concisely.' }],
    generateSummary: true,
  });
  console.log('description:', first.description.slice(0, 200));
  console.log('summary:    ', first.summary);

  console.log('\n=== 第二轮（纯文字追问）===');
  const second = await provider.analyze({
    images: [],
    messages: [
      { role: 'user', content: 'Describe this image concisely.' },
      { role: 'assistant', content: first.description },
      { role: 'user', content: 'What is the dominant color? Answer in one short sentence.' },
    ],
    generateSummary: false,
  });
  console.log('description:', second.description);
}

main().catch((err) => {
  console.error('smoke-multiturn failed:', err);
  process.exit(1);
});
