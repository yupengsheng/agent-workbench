# 设计系统基线

状态：v0.2 原型基线。生产组件实现前需要设计评审和可访问性验证。

## 视觉原则

- 以工作效率为中心：大面积浅灰画布、白色内容面板、深色文字，重点色只表达操作与状态。
- 执行记录优先于装饰：时间线、工具调用、来源和审批参数保持可扫描；不把“思考动画”当成进度证明。
- 层级来自间距、边框和字体重量；避免阴影堆叠和渐变背景，降低复杂任务的视觉噪声。
- 状态颜色同时配合文本和图标，不依赖色觉区分。

## Tokens

权威源是 [`design/tokens.json`](../../design/tokens.json)，Figma 插件和 Web 原型从这里读取。主要颜色：

| Token     | 值        | 用途                 |
| --------- | --------- | -------------------- |
| `canvas`  | `#F4F6F8` | 工作区背景           |
| `surface` | `#FFFFFF` | 卡片、表单、时间线   |
| `ink`     | `#172B3A` | 主文字               |
| `muted`   | `#546675` | 辅助文字与元数据     |
| `primary` | `#146A57` | 主操作、完成状态     |
| `blue`    | `#285FA4` | 信息、连接和运行状态 |
| `warning` | `#895400` | 审批、过期、断线     |
| `danger`  | `#AE353B` | 拒绝、失败、危险操作 |

控件最小交互高度 35px，生产版触控环境至少 40px；键盘焦点使用 3px 对比轮廓。文本、状态 badge 和按钮目标按 WCAG AA 逐项测试，不只依赖 tokens 的颜色对比。

## 组件状态

组件清单与业务状态映射见 [`module-boundaries.md`](../architecture/module-boundaries.md)。每个组件至少定义 default、hover、focus-visible、disabled、loading、empty、error；状态数据来自领域 reducer，组件不私自改变 Run、审批或权限。

## 原型使用

浏览器预览访问 `/prototype/`；设计定义位于 [`design/prototype/spec.json`](../../design/prototype/spec.json)。Figma 通过 `npm run figma:build` 生成 Foundations、Prototype、Architecture 页面。原型数据会显示“演示数据 · 不执行真实操作”，避免评审者误以为按钮已经接入后端。
