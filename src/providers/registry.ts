/**
 * Provider 注册中心。
 *
 * 各 provider 模块在 import 时通过 registerProvider() 自注册。
 * 本文件集中 import 所有 provider，确保应用启动时它们都被加载。
 * 入口/测试只需 import 本模块即可获得全部已注册 provider。
 *
 * 新增 provider 时：在下方加一行 import。
 */

import './openai.js';
// 后续 provider 在此注册：
// import './qwen.js';
// import './kimi.js';

export { getProvider, registerProvider } from './index.js';
export type {
  ProviderFactory,
  ProviderOpts,
  VisionMessage,
  VisionProvider,
  VisionRequest,
  VisionResponse,
} from './index.js';
