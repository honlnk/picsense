/**
 * 工具业务逻辑冒烟测试（mock provider，无需 API Key）。
 * 验证 analyze_images / list_sessions / analyze_document 的纯逻辑。
 *
 * 运行：pnpm smoke:tools
 */

import { analyzeImages, ToolInputError } from '../src/tools/analyze-images.js';
import { listSessions } from '../src/tools/list-sessions.js';
import { analyzeDocument } from '../src/tools/analyze-document.js';
import { SessionManager } from '../src/core/session-manager.js';
import type { VisionProvider, VisionRequest, VisionResponse } from '../src/providers/index.js';

class MockProvider implements VisionProvider {
  readonly name = 'mock';
  async analyze(req: VisionRequest): Promise<VisionResponse> {
    const n = req.images.length;
    return { description: `MOCK_DESC(${n} imgs)` };
  }
}

async function testAnalyzeImages(): Promise<void> {
  console.log('=== analyze_images / list_sessions ===');
  const mgr = new SessionManager(new MockProvider(), 5 * 1024 * 1024);

  // 首轮
  const r1 = await analyzeImages(mgr, {
    image_sources: ['https://example.com/a.png'],
    prompt: '描述这张图',
  });
  console.log('first:', { summary: r1.summary, desc: r1.description });
  if (r1.description !== 'MOCK_DESC(1 imgs)') throw new Error('首轮识别结果错误');
  if (!r1.session_id) throw new Error('应返回 session_id');

  // 多轮
  const r2 = await analyzeImages(mgr, {
    session_id: r1.session_id,
    prompt: '再看导航栏',
  });
  console.log('second:', { desc: r2.description, sameSession: r2.session_id === r1.session_id });
  if (r2.session_id !== r1.session_id) throw new Error('应复用同一 session');

  // 输入校验
  let threw = false;
  try {
    await analyzeImages(mgr, { image_sources: ['x'], prompt: '   ' });
  } catch (e) {
    threw = e instanceof ToolInputError;
  }
  if (!threw) throw new Error('空 prompt 应抛 ToolInputError');

  threw = false;
  try {
    await analyzeImages(mgr, { image_sources: [], prompt: 'x' });
  } catch (e) {
    threw = e instanceof ToolInputError;
  }
  if (!threw) throw new Error('首轮无图片应抛 ToolInputError');

  // list
  const list = await listSessions(mgr);
  console.log('list:', list.sessions.length, 'sessions, iteration=', list.sessions[0]?.iteration);
  if (list.sessions.length !== 1) throw new Error('应有 1 个 session');
  if (list.sessions[0]!.iteration !== 2) throw new Error('iteration 应为 2');
}

async function testAnalyzeDocument(): Promise<void> {
  console.log('\n=== analyze_document ===');
  const provider = new MockProvider();

  // markdown 含 2 张图（用 URL，URL 不在本地下载，mock provider 直接返回）
  const md = `# Title

Some text here.

![first](https://example.com/img1.png)

middle text

![second](https://example.com/img2.jpg)

end.`;
  const r = await analyzeDocument(provider, 5 * 1024 * 1024, 30000, { document: md });
  console.log('md result images_analyzed:', r.images_analyzed);
  console.log('md has annotation 1:', r.document.includes('<!-- image-vision: MOCK_DESC(1 imgs) -->'));
  console.log('md original images preserved:', /!\[first\]\(https:\/\/example\.com\/img1\.png\)/.test(r.document));
  if (r.images_analyzed !== 2) throw new Error('应识别 2 张图');
  const annotCount = (r.document.match(/<!-- image-vision: /g) || []).length;
  if (annotCount !== 2) throw new Error(`应有 2 处注释，实际 ${annotCount}`);

  // 本地不存在的路径 → 识别失败容错（计入注释但不计入 analyzed）
  const mdFail = '![bad](./nonexistent.png)';
  const rfLocal = await analyzeDocument(provider, 5 * 1024 * 1024, 30000, { document: mdFail });
  if (rfLocal.images_analyzed !== 0) throw new Error('不存在的本地图应失败，analyzed 应为 0');
  if (!rfLocal.document.includes('[识别失败')) throw new Error('应标注失败原因');

  // html 含 1 张图（用 URL）
  const html = `<html><body><h1>Hi</h1><img src="https://example.com/photo.jpg" alt="p"/><p>text</p></body></html>`;
  const rh = await analyzeDocument(provider, 5 * 1024 * 1024, 30000, { document: html });
  console.log('html result images_analyzed:', rh.images_analyzed);
  if (rh.images_analyzed !== 1) throw new Error('html 应识别 1 张图');
  if (!rh.document.includes('<img src="https://example.com/photo.jpg" alt="p"/>')) throw new Error('html 应保留原 img');

  // 无图文档
  const noImg = await analyzeDocument(provider, 5 * 1024 * 1024, 30000, { document: 'plain text no images' });
  if (noImg.images_analyzed !== 0) throw new Error('无图文档应返回 0');

  // 空文档
  const empty = await analyzeDocument(provider, 5 * 1024 * 1024, 30000, { document: '' });
  if (empty.images_analyzed !== 0) throw new Error('空文档应返回 0');

  // 图片识别失败容错（mock 抛错）
  const failProvider: VisionProvider = {
    name: 'fail',
    async analyze(): Promise<VisionResponse> {
      throw new Error('api down');
    },
  };
  const rf = await analyzeDocument(failProvider, 5 * 1024 * 1024, 30000, {
    document: '![x](./bad.png)',
  });
  console.log('fail-case images_analyzed:', rf.images_analyzed, 'doc:', rf.document);
  if (rf.images_analyzed !== 0) throw new Error('失败的图片不应计入 analyzed');
  if (!rf.document.includes('[识别失败')) throw new Error('应标注失败原因');
}

async function main(): Promise<void> {
  await testAnalyzeImages();
  await testAnalyzeDocument();
  console.log('\n✅ tools 全部测试通过');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
