/**
 * 环境变量配置管理。
 *
 * 设计依据：docs/picsense-design.md §6.2 —— 全部配置走环境变量，代码内零硬编码。
 * 缺失必填项时抛出清晰错误，便于用户在 stdio 启动时第一时间发现问题。
 */

/** 已实现的 provider 名称。 */
export type ProviderName = 'openai' | 'qwen' | 'kimi';

/** 单个 provider 的连接配置。 */
export interface ProviderConfig {
  /** provider 标识，用于 getProvider 工厂路由。 */
  readonly name: ProviderName;
  /** API Key，从环境变量读取。 */
  readonly apiKey: string;
  /** 模型名，从环境变量读取。 */
  readonly model: string;
  /** API base URL，未配置时各 provider 用自身默认值。 */
  readonly baseUrl?: string;
}

/** 全局配置。 */
export interface AppConfig {
  /** 默认 provider，由 DEFAULT_PROVIDER 指定。 */
  readonly defaultProvider: ProviderName;
  /** 所有已配置（带 Key）的 provider。 */
  readonly providers: Record<ProviderName, ProviderConfig | undefined>;
  /** 单张图片大小上限（字节），默认 5MB。 */
  readonly maxImageBytes: number;
  /** 视觉模型请求超时（毫秒），默认 300000（5 分钟）。 */
  readonly timeoutMs: number;
  /** session 过期时长（毫秒），默认 24 小时。 */
  readonly sessionTtlMs: number;
  /** session 清理任务执行间隔（毫秒），默认 1 小时。 */
  readonly sessionCleanupIntervalMs: number;
}

const ONE_MB = 1024 * 1024;
const ONE_HOUR = 60 * 60 * 1000;

const SUPPORTED_PROVIDERS: readonly ProviderName[] = ['openai', 'qwen', 'kimi'];

function isProviderName(value: string): value is ProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

function readProvider(
  name: ProviderName,
  env: Record<string, string | undefined>,
): ProviderConfig | undefined {
  const prefix = name.toUpperCase();
  const apiKey = env[`${prefix}_API_KEY`];
  const model = env[`${prefix}_MODEL`];
  const baseUrl = env[`${prefix}_BASE_URL`];
  // 没 Key 视为该 provider 未启用。
  if (!apiKey) return undefined;
  if (!model) {
    throw new ConfigError(`${prefix}_MODEL is required when ${prefix}_API_KEY is set.`);
  }
  return { name, apiKey, model, baseUrl };
}

/**
 * 加载并校验配置。必填项缺失时抛 ConfigError。
 *
 * @param env 可注入环境变量，默认读 process.env，便于测试。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const defaultProviderRaw = env['DEFAULT_PROVIDER'] ?? 'openai';
  if (!isProviderName(defaultProviderRaw)) {
    throw new ConfigError(
      `DEFAULT_PROVIDER="${defaultProviderRaw}" is not supported. Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }
  const defaultProvider = defaultProviderRaw;

  const providers: Record<ProviderName, ProviderConfig | undefined> = {
    openai: readProvider('openai', env),
    qwen: readProvider('qwen', env),
    kimi: readProvider('kimi', env),
  };

  // 默认 provider 必须可用（已配置 Key）。
  if (!providers[defaultProvider]) {
    const prefix = defaultProvider.toUpperCase();
    throw new ConfigError(
      `Default provider "${defaultProvider}" is not configured. ` +
        `Please set ${prefix}_API_KEY and ${prefix}_MODEL (see .env.example).`,
    );
  }

  const maxImageMb = Number(env['MAX_IMAGE_MB'] ?? '5');
  if (!Number.isFinite(maxImageMb) || maxImageMb <= 0) {
    throw new ConfigError(`MAX_IMAGE_MB="${env['MAX_IMAGE_MB']}" is not a positive number.`);
  }

  const timeoutMs = Number(env['TIMEOUT_MS'] ?? '300000');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`TIMEOUT_MS="${env['TIMEOUT_MS']}" is not a positive number.`);
  }

  return {
    defaultProvider,
    providers,
    maxImageBytes: Math.floor(maxImageMb * ONE_MB),
    timeoutMs,
    sessionTtlMs: 24 * ONE_HOUR,
    sessionCleanupIntervalMs: ONE_HOUR,
  };
}

/** 配置错误，携带面向用户的提示信息。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
