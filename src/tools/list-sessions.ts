/**
 * list_sessions 工具业务逻辑。
 *
 * 设计依据：docs/picsense-design.md §4.1、§4.2.5。
 * 返回当前所有 session 的列表（含简介、关联图片、迭代轮数、最后访问时间）。
 * 截断显示已由 SessionManager.toSnapshot 完成。
 */

import type { SessionManager, SessionSnapshot } from '../core/session-manager.js';

export interface ListSessionsResult {
  sessions: SessionSnapshot[];
}

export async function listSessions(manager: SessionManager): Promise<ListSessionsResult> {
  return { sessions: manager.listSessions() };
}
