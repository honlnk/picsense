/**
 * VisionProvider 抽象层。
 *
 * 设计依据：docs/picsense-design.md §5.2.2、§6.1 —— 参考 @systemmin/image-mcp 的接口设计，
 * 新增 provider 只需实现 VisionProvider 接口并在 getProvider 工厂注册。
 *
 * 多轮对话历史布局（见 docs/plan/03-session-manager.md）：
 * - 首轮 user message 含图（images 非空）。
 * - 后续轮次只有文字，provider 把 messages 拼成原生多轮 messages 数组发给视觉模型。
 */

import type { LoadedImage } from '../core/image-loader.js';
import type { ProviderConfig } from '../utils/config.js';

/** 对话历史中的一条消息（纯文字层，图片由 images 单独传）。 */
export interface VisionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 调用视觉模型的请求。 */
export interface VisionRequest {
  /** 本轮要附加在首轮 user 文字之后的图片。仅在首轮（创建 session）非空。 */
  images: LoadedImage[];
  /** 完整的多轮对话历史（含本轮新增的 user prompt，由调用方拼好）。 */
  messages: VisionMessage[];
  /** 首轮为 true，要求模型同时生成一句 session 简介。 */
  generateSummary?: boolean;
}

/** 视觉模型返回。 */
export interface VisionResponse {
  /** 识别结果（纯文本描述）。 */
  description: string;
  /** 仅 generateSummary=true 时返回；session 简介。 */
  summary?: string;
}

/** 每个 provider 必须实现的接口。 */
export interface VisionProvider {
  readonly name: string;
  analyze(req: VisionRequest): Promise<VisionResponse>;
}

/** provider 工厂入参：从 AppConfig.providers 传入对应 provider 的配置。 */
export type ProviderFactory = (cfg: ProviderConfig, opts: ProviderOpts) => VisionProvider;

/** 跨 provider 共享的运行时选项。 */
export interface ProviderOpts {
  /** 请求超时（毫秒）。 */
  timeoutMs: number;
}

/** 已注册的 provider 工厂表。新增 provider 时在此注册即可。 */
const FACTORIES: Partial<Record<string, ProviderFactory>> = {};

/** 供 provider 模块自注册用。 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  FACTORIES[name] = factory;
}

/**
 * 按 provider 名称构造实例。
 *
 * @param name provider 名称（如 'openai'）。
 * @param cfg 该 provider 的配置（API Key / model / baseUrl）。
 * @param opts 跨 provider 的运行时选项。
 */
export function getProvider(
  name: string,
  cfg: ProviderConfig,
  opts: ProviderOpts,
): VisionProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown provider "${name}". Supported: ${Object.keys(FACTORIES).join(', ') || '(none registered yet)'}.`,
    );
  }
  return factory(cfg, opts);
}
