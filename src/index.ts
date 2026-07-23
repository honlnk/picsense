#!/usr/bin/env node
/**
 * picsense MCP 入口。
 *
 * 启动顺序：
 * 1. 加载并校验配置（缺失必填项 → 友好报错到 stderr 后退出）。
 * 2. 构造默认 provider（触发 provider 注册）。
 * 3. 创建 SessionManager（含多轮迭代、并发隔离、24h 过期清理）。
 * 4. 注册 3 个工具：analyze_images / list_sessions / analyze_document。
 * 5. 经 stdio 传输与 MCP 客户端通信。
 *
 * 设计依据：docs/picsense-design.md §4.1、§6.3；docs/plan/05-mcp-entry.md。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig, ConfigError } from './utils/config.js';
import './providers/registry.js'; // 触发 provider 自注册
import { getProvider } from './providers/registry.js';
import { SessionManager } from './core/session-manager.js';
import { analyzeImages, ToolInputError } from './tools/analyze-images.js';
import { listSessions } from './tools/list-sessions.js';
import { analyzeDocument } from './tools/analyze-document.js';
import { SessionNotFoundError } from './core/session-manager.js';

/** 把结果对象包成 MCP 文本 content（标准做法）。 */
function asText(obj: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** 把错误包成 isError 的工具结果（MCP 标准的错误信号方式）。 */
function asError(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // 配置错误：直接退出，提示走 stderr（stdout 留给 JSON-RPC）。
    if (err instanceof ConfigError) {
      process.stderr.write(`[picsense] config error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // 构造默认 provider。
  const providerCfg = config.providers[config.defaultProvider];
  if (!providerCfg) {
    process.stderr.write(
      `[picsense] default provider "${config.defaultProvider}" is not configured.\n`,
    );
    process.exit(1);
  }
  const provider = getProvider(config.defaultProvider, providerCfg, {
    timeoutMs: config.timeoutMs,
  });

  // Session 管理器，启动定时清理。
  const sessionManager = new SessionManager(
    provider,
    config.maxImageBytes,
    config.sessionTtlMs,
    config.sessionCleanupIntervalMs,
  );
  sessionManager.startCleanup();

  const server = new McpServer(
    { name: 'picsense', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ===== 工具 1：analyze_images =====
  server.registerTool(
    'analyze_images',
    {
      description:
        '识别图片内容。传入一张图片为单图识别，传入多张为批量或对比识别。' +
        '支持多轮迭代——首次调用创建 session，后续调用传入 session_id 可在已有对话基础上追加提问。',
      inputSchema: {
        image_sources: z
          .array(z.string())
          .optional()
          .describe('图片来源数组（传一张为单图识别，传多张为批量/对比），每项自动识别 http URL / 本地文件路径 / base64。首次调用创建 session 时必填；后续轮次传入 session_id 时可省略（沿用该 session 的图片）'),
        prompt: z.string().describe('对图片的识别要求，根据当前任务意图编写'),
        session_id: z
          .string()
          .optional()
          .describe('传入已有 session 的 ID 以发起后续轮次；不传则创建新 session'),
      },
    },
    async (args) => {
      try {
        const result = await analyzeImages(sessionManager, {
          image_sources: args.image_sources,
          prompt: args.prompt,
          session_id: args.session_id,
        });
        return asText(result);
      } catch (err) {
        return asError(formatError(err));
      }
    },
  );

  // ===== 工具 2：list_sessions =====
  server.registerTool(
    'list_sessions',
    {
      description:
        '查看当前所有识别会话的列表，包括每个 session 的简介、关联图片和迭代轮数。用于回顾历史识别记录。',
    },
    async () => {
      const result = await listSessions(sessionManager);
      return asText(result);
    },
  );

  // ===== 工具 3：analyze_document =====
  server.registerTool(
    'analyze_document',
    {
      description:
        '解析文档，识别其中所有图片的内容，并在图片位置旁标注描述。返回标注后的完整文档。',
      inputSchema: {
        document: z.string().describe('文档 URL / HTML / markdown（自动识别）'),
      },
    },
    async (args) => {
      try {
        const result = await analyzeDocument(
          provider,
          config.maxImageBytes,
          config.timeoutMs,
          { document: args.document },
        );
        return asText(result);
      } catch (err) {
        return asError(formatError(err));
      }
    },
  );

  // stdio 传输。
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[picsense] started (provider=${config.defaultProvider}, model=${providerCfg.model})\n`,
  );

  // 进程退出时清理定时器（session 内存态自然清空，无需持久化善后）。
  const shutdown = (): void => {
    sessionManager.stopCleanup();
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
}

/** 把各类错误格式化成面向用户的提示。 */
function formatError(err: unknown): string {
  if (err instanceof SessionNotFoundError) {
    return err.message + ' 该 session 可能已过期（超过 24 小时）或进程已重启。请重新发起首次识别。';
  }
  if (err instanceof ToolInputError) {
    return `参数错误: ${err.message}`;
  }
  if (err instanceof Error) {
    return `识别失败: ${err.message}`;
  }
  return `识别失败: ${String(err)}`;
}

main().catch((err) => {
  process.stderr.write(
    `[picsense] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
