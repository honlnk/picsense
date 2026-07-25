# P1：项目脚手架

> 依赖：无
> 目标：产出可编译、可运行的空壳工程，为后续阶段铺路。

## 任务清单

- [ ] 初始化 `package.json`（name=picsense，type=module，bin 指向 dist）
- [ ] 安装依赖
  - 生产：`@modelcontextprotocol/sdk`、`zod`
  - 开发：`typescript`、`@types/node`、`tsx`（调试用）
- [ ] 配置 `tsconfig.json`（strict、ESNext、moduleResolution=bundler、outDir=dist）
- [ ] 建立目录骨架（与设计文档 §6.3 一致）
  ```
  src/
  ├── index.ts
  ├── tools/
  ├── providers/
  ├── core/
  └── utils/config.ts
  ```
- [ ] `src/utils/config.ts`：环境变量加载器
  - 读取并校验 `DEFAULT_PROVIDER`、`OPENAI_API_KEY`、`OPENAI_MODEL` 等
  - 导出类型安全的 `config` 对象
  - 缺失必填项时抛清晰错误
- [ ] `src/index.ts`：最小可运行占位（`console.log` 或空 MCP server），保证 `pnpm build` 通过
- [ ] `package.json` scripts：`build`、`dev`（tsx watch）、`start`
- [ ] 验证：`pnpm install && pnpm build` 成功，无类型错误

## 验收

- `pnpm build` 产出 `dist/index.js`
- `node dist/index.js` 可执行（即使是空逻辑）
- `src/utils/config.ts` 能正确读取并校验环境变量
