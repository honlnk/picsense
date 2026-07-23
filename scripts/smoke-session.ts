/**
 * Session 管理器冒烟测试（mock provider，无需 API Key）。
 * 验证：创建/追加、多轮 messages 累积、并发隔离、事务性、过期清理。
 *
 * 运行：pnpm smoke:session
 */

import { SessionManager } from '../src/core/session-manager.js';
import type { VisionProvider, VisionRequest, VisionResponse } from '../src/providers/index.js';

/** mock provider：记录每次调用，返回可预测内容。 */
class MockProvider implements VisionProvider {
  readonly name = 'mock';
  calls = 0;
  failNext = false;

  async analyze(req: VisionRequest): Promise<VisionResponse> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock provider failure');
    }
    const turns = req.messages.filter((m) => m.role === 'user').length;
    const description = `desc-turn-${turns} (images=${req.images.length}, msgs=${req.messages.length})`;
    return req.generateSummary
      ? { description, summary: `summary-of-turn-${turns}` }
      : { description };
  }
}

async function main(): Promise<void> {
  const provider = new MockProvider();
  const mgr = new SessionManager(provider, 5 * 1024 * 1024);

  // 1. 创建 session
  const first = await mgr.createSession(['https://example.com/a.png'], '首轮：整体描述');
  console.log('1. create:', { id: first.session_id.slice(0, 8), summary: first.summary, desc: first.description });
  if (first.summary !== 'summary-of-turn-1') throw new Error('summary 错误');
  if (!first.description.includes('images=1')) throw new Error('首轮应带图');

  // 2. 追加一轮
  const second = await mgr.appendTurn(first.session_id, '第二轮：细看导航栏');
  console.log('2. append:', { desc: second.description });
  if (second.summary !== 'summary-of-turn-1') throw new Error('后续轮 summary 应保持首轮值');
  // 第二轮发送的历史：[u1, a1, u2] = 3 条（provider 收到的）
  if (!second.description.includes('msgs=3')) throw new Error('第二轮应发送 3 条消息(u1,a1,u2)');

  // 3. 事务性：provider 失败不污染历史
  provider.failNext = true;
  let threw = false;
  try {
    await mgr.appendTurn(first.session_id, '会失败的一轮');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('provider 失败应抛出');
  const afterFail = await mgr.appendTurn(first.session_id, '第三轮');
  console.log('3. after-fail:', { desc: afterFail.description });
  // 失败轮未落库，历史仍为 [u1,a1,u2,a2]，第三轮发送 [u1,a1,u2,a2,u3] = 5 条
  if (!afterFail.description.includes('msgs=5')) {
    throw new Error('失败轮不应污染历史，第三轮应发送 5 条消息');
  }

  // 4. list_sessions
  const list = mgr.listSessions();
  console.log('4. list:', list);
  if (list.length !== 1) throw new Error('应有 1 个 session');
  if (list[0]!.iteration !== 3) throw new Error('iteration 应为 3');

  // 5. 并发隔离：同一 session 并发 3 轮应串行
  const sessionId = first.session_id;
  const before = provider.calls;
  const results = await Promise.all([
    mgr.appendTurn(sessionId, '并发A'),
    mgr.appendTurn(sessionId, '并发B'),
    mgr.appendTurn(sessionId, '并发C'),
  ]);
  console.log('5. concurrent:', results.map((r) => r.description));
  const msgCounts = results.map((r) => {
    const m = r.description.match(/msgs=(\d+)/);
    return m ? Number(m[1]) : -1;
  });
  console.log('   msgCounts:', msgCounts, 'calls delta:', provider.calls - before);
  // 串行：6 条历史 + uA = 7, 8 committed + uB = 9, 10 committed + uC = 11
  if (!(msgCounts[0] === 7 && msgCounts[1] === 9 && msgCounts[2] === 11)) {
    throw new Error(`并发应严格串行，期望 [7,9,11]，实际 ${msgCounts}`);
  }

  // 6. SessionNotFoundError
  try {
    await mgr.appendTurn('nonexistent-id', 'x');
    throw new Error('应抛 SessionNotFoundError');
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'SessionNotFoundError') throw e;
    console.log('6. not-found: 正确抛出 ✅');
  }

  // 7. 过期清理
  const expiredMgr = new SessionManager(new MockProvider(), 5 * 1024 * 1024, /*ttl*/ 100, /*interval*/ 1000);
  await expiredMgr.createSession(['https://example.com/a.png'], 'x');
  if (expiredMgr.size !== 1) throw new Error('清理前应有 1 个');
  await new Promise((r) => setTimeout(r, 150)); // 等 ttl 过期
  const removed = expiredMgr.cleanup();
  console.log('7. cleanup:', { removed, sizeAfter: expiredMgr.size });
  if (removed !== 1 || expiredMgr.size !== 0) throw new Error('过期 session 应被清理');

  console.log('\n✅ session-manager 全部测试通过');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
