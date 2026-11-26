# 从维护站点刷新发布版

该脚本只同步审阅清单中列出的通用前端、管理界面与 API 模块。它不会遍历或复制整个源站目录；账号、运行目录、部署脚本、私有接口、原始新闻数据与原始图片、音频都不在发布清单中。

从包含公开版与维护站源码的共同父目录执行。

```powershell
node public-source/tools/sync-from-site.cjs --review
```

程序把候选文件写到 `.preview/public-source-review/`，逐个检查其中的页面差异和安全扫描结果。只有在候选仍然通过审阅、目标文件在清单内时，应用本轮输出的 SHA-256 审阅摘要：

```powershell
node public-source/tools/sync-from-site.cjs --apply <本轮审阅显示的摘要>
node public-source/tools/check-release.js --seal
node public-source/tools/check-release.js
node --test public-source/test
```

如果站点源码目录不在默认相邻路径，先指定精确目录：

```powershell
$env:GTAVI_SITE_SOURCE = 'G:\work\gta6-pc-port-dashboard'
node public-source/tools/sync-from-site.cjs --review
```

源文件在审阅期间变化会导致摘要不匹配并拒绝写入。每次同步都要重新查看候选，并运行测试与发布检查。不要把 `.preview/` 运行记录、账号、截图以外的素材或任何环境/密钥文件加入同步输入。`release-manifest.json` 对发布文件清单记录 SHA-256；代码、README 或许可更新后必须重新封存并验证。

## 只审阅多语言改动

用 `--review --i18n` 生成四页、词典、语言切换、公共控件和内容投影模块的候选。逐文件核对后挑选改动，或用本轮摘要加 `--apply <摘要> --i18n` 整批应用。公开版自行维护两个本地入口、内容存储、RSS、评分及虚构种子。新增界面键和编辑译文的步骤见[三语维护说明](localization.md)。

使用 `GTAVI_EXPORT_REVIEW_DIR` 为每次审阅指定不同的空目录，避免混入以前生成的候选。Fluent 图标库只从维护站更新 `translate` 图标，其余图标沿用公开版。

## Pull Request 协作

1. 从默认分支创建独立分支，先在 `.preview/` 内保存本轮审阅材料。
2. 只同步清单允许的通用源码；不要复制生产数据、原始媒体、账号库、运行目录或部署凭据。
3. 运行 `node --test`、`node tools/check-release.js`，并用 `node server.js` 做本地启动冒烟；必要时用 `node preview.js` 检查脱敏演示。
4. 在 Pull Request 中说明来源、许可、排除项、测试和是否改变 API；至少一名维护者审阅后再合并。
5. 合并后重新生成 `release-manifest.json`，检查提交差异，再由维护站人工挑选同步，不自动覆盖生产。
