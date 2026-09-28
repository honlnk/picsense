# picsense 仓库约定（给 AI 会话与协作者）

## 合并方式（强约束）

- PR 一律用**普通合并（merge commit）**：`gh pr merge <N> --merge`。
- 仓库设置已禁用 squash / rebase 合并，命令会被 GitHub 拒绝——不要尝试，更不要为此去改仓库设置。
- 合并后在 dev 上 `git pull origin main` 快进同步即可；**永远不要对 dev 或 main 做 force push**（历史上唯一一次 dev force-sync 是 squash 时代的遗留操作，随 squash 一起废止）。

## 发布流程

1. 改动合入 main（PR + merge commit）。
2. `package.json` bump 版本，打 tag 并推送（annotated tag：`git tag -a vX.Y.Z -m "..."`），tag 推送自动触发：
   - `release-npm.yml` — npm Trusted Publishing（OIDC，无需 token）
   - `deploy-pages.yml` — 部署 `docs/index.html` 到 GitHub Pages（picsense.honlnk.com）
3. 用 `gh run watch` 确认两条流水线 success，再 `npm view @honlnk/picsense version` 验证（注册表有 1-2 分钟延迟）。

## 历史说明（2026-09-29）

v0.1.1（PR #2）与 v0.2.0（PR #4）时代曾用 squash 合并，其提交是 npm provenance 的锚点，**保留原样、不改写**。自 PR #5 起均为 merge commit。
