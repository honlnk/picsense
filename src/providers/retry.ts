/**
 * 通用重试工具。参考 @z_ai/mcp-server 的 withRetry（设计文档 附录 A.4）：
 * 最多重试 maxRetries 次，每次间隔 baseDelayMs，仅对网络/服务端错误重试。
 */

/** 简单的 sleep。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断错误是否值得重试：网络错误或 5xx/429。
 * 4xx（除 429）通常是请求本身的问题，重试无意义。
 */
export function isRetryable(status: number | undefined, error: unknown): boolean {
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // 无 status（网络层错误，如 DNS/连接超时）—— 重试。
  return error instanceof TypeError;
}

/**
 * 带重试地执行 fn。
 *
 * @param fn 待执行函数。
 * @param maxRetries 最大重试次数（不含首次）。
 * @param baseDelayMs 首次重试前等待毫秒数；每次翻倍。
 */
export async function withRetry<T>(
  fn: () => Promise<{ status: number; result: T }>,
  maxRetries = 2,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { result } = await fn();
      return result;
    } catch (err) {
      lastError = err;
      // 错误对象上携带的 status 字段（见 OpenAIProvider 抛出的 ProviderHttpError）。
      const status = (err as { status?: number }).status;
      if (attempt < maxRetries && isRetryable(status, err)) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  throw lastError;
}
