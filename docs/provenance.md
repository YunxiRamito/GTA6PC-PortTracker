# 来源与许可

## 发布审计边界

本仓库的源码导出以通用逻辑为边界，不是生产数据备份。发布审计检查了清单路径、敏感字符串、外链主机、媒体文件和运行目录；排除用户数据库、账号/会话、生产凭据、令牌、私钥、`.preview/`、浏览器 profile、日志、原始图片与音频。演示截图为脱敏样例，站点封面由 CSS 绘制。

PortWatch VI 只作为进度评分方法和数据结构的参考。`assets/port-score.js` 是独立重写的实现，没有复制 PortWatch 源码；由于固定上游修订未声明可复用许可证，公开仓库不将其代码或未授权素材打包进来。

## Portwatch VI 评分方法

核对的上游修订为 `98f78dde8ed87ccb9bb67588e160d1aab7ca814d`。该修订的根目录与仓库元数据均未列出复用许可。维护站现有实现采用相同的阶梯、权重和类似的控制结构。公开仓库以新的 JavaScript 实现同一评分方法，并沿用本站的接口与回归用例。[上游仓库](https://github.com/4lwayz/portwatch-vi) · [固定修订](https://github.com/4lwayz/portwatch-vi/tree/98f78dde8ed87ccb9bb67588e160d1aab7ca814d) · [评分方法](https://github.com/4lwayz/portwatch-vi/blob/98f78dde8ed87ccb9bb67588e160d1aab7ca814d/assets/js/scoring.js)

- 基础准备占 25 分，加载器、着色器、图形层和其他场景验证的权重为 20%、28%、32% 和 20%。
- 程序运行、首帧、主菜单和进入游戏分别对应 25、40、55 和 70 分。首个未完成的阶段按完成比例插值。
- 进入游戏后，30 FPS 与稳定性各计最多 15 分。本站按档案顺序处理同分项目，输出领先分数、前三平均值、最远阶段和达到启动阶段的项目数。

## 随仓库分发的第三方文件

| 组件 | 此仓库的用法 | 随附许可与版本来源 |
| --- | --- | --- |
| Lenis 1.3.17 | `assets/vendor/lenis.min.js` 提供精细指针的平滑滚动。文件与该版本 npm 包中的构建一致。 | [MIT](../assets/vendor/Lenis-LICENSE.txt) · [固定源码](https://github.com/darkroomengineering/lenis/tree/3dc917bfdc8e2f11e72b7a43f7bb51c4ad2a2f88) · [npm 构建](https://registry.npmjs.org/lenis/-/lenis-1.3.17.tgz) |
| Microsoft Fluent UI System Icons | `assets/ui/fluent.svg` 为 24 px regular 图标子集。各路径与固定修订的 SVG 一致。 | [MIT](../assets/ui/Fluent-LICENSE.txt) · [固定素材目录](https://github.com/microsoft/fluentui-system-icons/tree/a3de63245b4fa49c30e20d9838593a105affe774/assets) |
| Primer Octicons | `assets/ui/octicons.svg` 为工程指标和导航图标子集。各路径与固定修订的 SVG 一致。 | [MIT](../assets/ui/Octicons-LICENSE.txt) · [固定素材目录](https://github.com/primer/octicons/tree/e6626e159c4ba786d512e252182b62617014c752/icons) |
| Barlow | 正文使用 Google Fonts 的 400 与 700 Latin WOFF2 文件。 | [SIL OFL 1.1](../assets/ui/OFL-Barlow.txt) · [字体来源](https://github.com/google/fonts/tree/83c62e30d87daa70216dab6b984d00d20d96d585/ofl/barlow) · [400](https://fonts.gstatic.com/s/barlow/v13/7cHpv4kjgoGqM7E_DMs5.woff2) · [700](https://fonts.gstatic.com/s/barlow/v13/7cHqv4kjgoGqM7E3t-4s51os.woff2) |
| Barlow Condensed | 标题使用 Google Fonts 的 700 与 900 Latin WOFF2 文件。 | [SIL OFL 1.1](../assets/ui/OFL-BarlowCondensed.txt) · [字体来源](https://github.com/google/fonts/tree/83c62e30d87daa70216dab6b984d00d20d96d585/ofl/barlowcondensed) · [700](https://fonts.gstatic.com/s/barlowcondensed/v13/HTxwL3I-JCGChYJ8VI-L6OO_au7B46r2z3bWuQ.woff2) · [900](https://fonts.gstatic.com/s/barlowcondensed/v13/HTxwL3I-JCGChYJ8VI-L6OO_au7B45L0z3bWuQ.woff2) |

## 本站源码与视觉参考

首页、工程档案、关于页、鸣谢页和管理控制台源自本站维护的 HTML、CSS 和 JavaScript。首页布局参考过项目内的本地原型，首屏留白与滚动节奏参考过 Rockstar 的公开游戏页。此版封面由 `assets/demo.css` 绘制，README 截图取自本地演示。

GitHub 提供可配置的项目元数据 API。维护者可在本地控制台建立自己的弹幕词表。站点启动时使用空词表。
