/**
 * 端到端 stdio 客户端测试：spawn 真实的 picsense server 进程，用 NDJSON-RPC 验证。
 *
 * MCP stdio 传输协议：每条消息是一行 JSON + 换行（非 HTTP Content-Length 分帧）。
 *
 * 验证点：
 * 1. initialize 握手成功
 * 2. tools/list 返回 3 个工具
 * 3. tools/call list_sessions 返回空列表
 * 4. tools/call analyze_images 参数校验生效（空 prompt → isError）
 *
 * 注：真实图片识别需要有效 OPENAI_API_KEY，这里只验证管线连通与参数校验。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = new URL('../dist/index.js', import.meta.url).pathname;

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function send(proc: ChildProcessWithoutNullStreams, msg: Record<string, unknown>): void {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

/** 收集一段时间内所有带 id 或 error 的响应。 */
function collectResponses(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<JsonRpcResponse[]> {
  return new Promise((resolve) => {
    const responses: JsonRpcResponse[] = [];
    let buffer = '';
    const timer = setTimeout(() => {
      proc.stdout.removeListener('data', onData);
      resolve(responses);
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== undefined || parsed.error) responses.push(parsed);
        } catch {
          /* ignore */
        }
      }
    };
    proc.stdout.on('data', onData);
  });
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    DEFAULT_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-fake',
    OPENAI_MODEL: 'chatgpt-5.6-sol',
  };
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });

  // 1. initialize
  send(proc, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.0' } },
  });
  // 通知（无 id）
  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const initResp = await collectResponses(proc, 2000);
  const initOk = initResp.some((r) => r.id === 1 && r.result);
  console.log('1. initialize:', initOk ? 'OK' : 'FAIL');
  if (!initOk) throw new Error('initialize 失败');

  await delay(150);

  // 2. tools/list
  send(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listResp = await collectResponses(proc, 2000);
  const tools = ((listResp.find((r) => r.id === 2)?.result as { tools?: Array<{ name: string }> })?.tools) ?? [];
  const toolNames = tools.map((t) => t.name).sort();
  console.log('2. tools/list:', toolNames);
  const expected = ['analyze_document', 'analyze_images', 'list_sessions'];
  if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
    throw new Error(`工具列表不符，期望 ${expected.join(',')}`);
  }

  await delay(150);

  // 3. list_sessions
  send(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
  const lsResp = await collectResponses(proc, 2000);
  const lsResult = lsResp.find((r) => r.id === 3)?.result as { content?: Array<{ text: string }> };
  console.log('3. list_sessions:', lsResult?.content?.[0]?.text?.replace(/\s+/g, ' ').slice(0, 80));

  await delay(150);

  // 4. analyze_images 参数校验（空 prompt → isError）
  send(proc, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'analyze_images', arguments: { image_sources: ['https://example.com/a.png'], prompt: '   ' } },
  });
  const badResp = await collectResponses(proc, 2000);
  const badResult = badResp.find((r) => r.id === 4)?.result as { isError?: boolean; content?: Array<{ text: string }> };
  console.log('4. analyze_images bad-prompt isError:', badResult?.isError, '|', badResult?.content?.[0]?.text?.slice(0, 50));
  if (!badResult?.isError) throw new Error('空 prompt 应触发 isError');

  proc.kill();
  console.log('\n✅ 端到端管线验证通过（3 工具已注册、参数校验生效、NDJSON 通信正常）');
}

main().catch((e) => {
  console.error('E2E FAIL:', e);
  process.exit(1);
});
