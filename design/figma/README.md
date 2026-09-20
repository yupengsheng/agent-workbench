# Figma 原型插件

该插件从仓库中的 `design/tokens.json`、`design/prototype/spec.json` 和 `design/architecture.json` 生成可编辑的 Figma 页面：

- `00 Foundations`：颜色 tokens、按钮/状态/产物卡片组件。
- `01 Prototype · Flows`：21 个页面状态和按钮连线，覆盖任务创建、执行、子任务、审批、批准/拒绝/过期、失败、断线、取消、报告、Agent 版本发布、模型异常和审计。
- `02 Architecture`：目标技术架构图。

插件生成的画布是开发基线，不能替代设计师在 Figma 中对间距、字体、可访问性和 Present 模式逐页验收。

## 首次使用

1. 在 Figma Desktop 创建一个本地开发插件：Plugins → Development → New Plugin → Create new plugin。
2. 选择 **Plugin / Blank**，把 Figma 生成的 manifest ID 保留在本地 manifest 中。
3. 将本仓库 `design/figma/manifest.example.json` 中除 `id` 外的字段合并到该 manifest，并让 `main` 指向 `dist/code.js`。
4. 在仓库根目录执行 `npm run figma:build`。
5. 在 Figma Development plugins 菜单中运行插件，选择刚生成的 `design/figma/dist/code.js` 所属 manifest。

Figma 新插件要求 `documentAccess: dynamic-page`；manifest 通过 `networkAccess.allowedDomains: ["none"]` 明确声明插件不访问网络。若 Figma 要求插件 ID，不能把 `REPLACE_WITH_FIGMA_PLUGIN_ID` 当成真实 ID；必须使用 Figma 创建插件时分配的 ID。

## 修改原型

不要直接把页面逻辑写死在插件里。先改 `design/tokens.json`、`design/prototype/spec.json` 或 `design/architecture.json`，再重新构建插件。交互状态和流转集中在 `spec.json` 的 `screens` / `actions` / `flows`，浏览器预览与 Figma 生成器共同使用它们。

Figma Plugin API 的 `setReactionsAsync` 生成 `ON_CLICK` → `NAVIGATE` / `OVERLAY` 交互；Figma 页面中可继续人工调整转场。该 API 能力和 manifest 要求来自 Figma 官方文档及本地 `@figma/plugin-typings`；本项目没有真实 Figma 文件写入凭证，不能在仓库中伪称已生成云端文件。
