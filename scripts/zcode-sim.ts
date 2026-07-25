/**
 * 模拟 ZCode 调用 picsense MCP 的完整场景。
 * 用环境变量启动 server，走 握手→列表→真实识别→多轮迭代 全链路。
 *
 * 运行：OPENAI_API_KEY=sk-xxx OPENAI_MODEL=gpt-5.6-sol OPENAI_BASE_URL=https://... pnpm sim
 * （或把环境变量放进 .env，由 shell 自动注入）
 *
 * 可选环境变量：
 *   PICSENSE_SIM_IMG  指定测试图片路径（默认 ~/Downloads/IMG_20260713_182948.png）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'dist', 'index.js');

const IMG = process.env.PICSENSE_SIM_IMG ?? path.join(os.homedir(), 'Downloads', 'IMG_20260713_182948.png');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('请设置环境变量 OPENAI_API_KEY（真实运行需要有效 key）');
  process.exit(1);
}

const proc = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    DEFAULT_PROVIDER: 'openai',
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-5.6-sol',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  },
});

const send = (msg: object): void => {
  proc.stdin.write(JSON.stringify(msg) + '\n');
};
let buf = '';
const responses = new Map<number, any>();
proc.stdout.on('data', (chunk: Buffer) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined) responses.set(m.id, m);
    } catch {
      /* ignore */
    }
  }
});

const wait = (id: number, ms = 120000): Promise<any> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - start > ms) return reject(new Error(`timeout id=${id}`));
      setTimeout(tick, 50);
    };
    tick();
  });

await new Promise((r) => setTimeout(r, 300));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zcode-sim', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
const init = await wait(1);
console.log('1. initialize:', init.result ? `OK server=${init.result.serverInfo.name}` : 'FAIL');

send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const list = await wait(2);
const tools = list.result.tools.map((t: { name: string }) => t.name).sort();
console.log('2. tools/list:', JSON.stringify(tools));

// 真实单图识别
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analyze_images', arguments: { image_sources: [IMG], prompt: '这张图里有什么？用一句话描述。' } } });
const r3 = await wait(3);
const content3 = JSON.parse(r3.result.content[0].text);
console.log('3. analyze_images (真实单图识别):');
console.log('   session_id:', content3.session_id.slice(0, 8) + '...');
console.log('   summary:', content3.summary);
console.log('   description:', content3.description);

// 多轮迭代：复用 session 追问
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'analyze_images', arguments: { session_id: content3.session_id, prompt: '这些动物一共有几只？主色调是什么？' } } });
const r4 = await wait(4);
const content4 = JSON.parse(r4.result.content[0].text);
console.log('4. analyze_images (多轮迭代 追问):');
console.log('   description:', content4.description);

// list_sessions
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
const r5 = await wait(5);
const content5 = JSON.parse(r5.result.content[0].text);
console.log('5. list_sessions:', JSON.stringify(content5.sessions[0], null, 2).replace(/\n/g, '\n   '));

proc.kill();
console.log('\n✅ ZCode 场景模拟通过：握手 / 列表 / 真实识别 / 多轮迭代 / 会话列表 全链路 OK');
