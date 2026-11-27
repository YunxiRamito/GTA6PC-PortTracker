# 来源与许可

## 发布审计边界

本仓库的源码导出以通用逻辑为边界，不是生产数据备份。发布审计检查了清单路径、敏感字符串、外链主机、媒体文件和运行目录；排除用户数据库、账号/会话、生产凭据、令牌、私钥、`.preview/`、浏览器 profile、日志、原始图片与音频。演示截图为脱敏样例，站点封面由 CSS 绘制。

PortWatch VI 只作为进度评分方法和数据结构的参考。`assets/port-score.js` 是独立重写的实现，没有复制 PortWatch 源码；由于固定上游修订未声明可复用许可证，公开仓库不将其代码或未授权素材打包进来。

## 评分 V5 与来源

旧版分段与证据组织参考 PortWatch VI。已核对的固定上游修订未列出复用许可；本站 V5 沿用独立实现和自有规则，不分发上游代码或素材。[上游仓库](https://github.com/4lwayz/portwatch-vi) · [固定修订](https://github.com/4lwayz/portwatch-vi/tree/98f78dde8ed87ccb9bb67588e160d1aab7ca814d) · [评分方法](https://github.com/4lwayz/portwatch-vi/blob/98f78dde8ed87ccb9bb67588e160d1aab7ca814d/assets/js/scoring.js)

- 后半段以监狱序章为门槛。加载启动、首帧、菜单、进入游戏和监狱序章依次对应 15、30、35、40、50 分；首个未完成阶段按比例插值。旧帧率、稳定性和完整性记录不会解锁 V5 计分。
- 后半段最多加 50 分：45 分给画面与帧率，5 分给稳定性。画面与帧率子分先取 `80% × 较低分 + 15% × 画面分 + 5% × 帧率分`。稳定性从 50 开始，有依据的无故障复测加分，闪退、卡死、图形设备丢失减分。
- 固定参考配置 `i7-12700-rtx-4060-v1`：Core i7-12700、桌面 RTX 4060（8 GB 显存）、双通道 16 GB DDR4-3200、SSD、Windows 11 64 位。同一构建和参考设置下，只采原生 1920×1080，关闭动态分辨率、超分、补帧和 DLSS 5。每个固定路段跑三次，取帧率中位并按路段时长汇总；严重漏绘或粗模会限制画面子分。缺测项为 `null`，不是实测 0 分；画面或帧率缺测时，总分不超过 50。
- 两个本地入口的 `/api/dashboard` 使用同一个 V5 排名投影，保留 `progress.history`。服务端的 `progress-history.v5.json` 与旧历史文件分开；只读演示使用独立的合成 V5 序列。随仓库分发的分项、源链接和构建标识均为虚构示例，不代表实际硬件测量或生产站档案。

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
