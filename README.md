# ReleasePort

本地优先的多平台应用发布控制台。Android 使用 `apkgo`，iOS 使用 App Store Connect API Key 与 `fastlane deliver`。

## 当前版本

第一阶段已经包含：

- 应用、渠道版本和发布任务总览
- ApkGo 全部 Android 渠道凭证管理：华为、荣耀、小米、OPPO、vivo、魅族、应用宝、三星、Google Play、蒲公英、fir.im
- Apple App Store Connect API Key 凭证管理
- AES-256-GCM 本地加密凭证库，密钥不进入浏览器存储
- APK、AAB、IPA 本地上传和 SHA-256 记录
- 立即提交、定时开始、审核后自动/手动/定时发布策略
- Android `apkgo --progress-stream --creds-from=stdin` 执行适配器
- iOS `fastlane deliver` 执行适配器
- SQLite 状态持久化、15 秒本地任务调度和渠道级结果
- 桌面与移动端管理界面

已支持安装包元数据解析与提交后审核状态同步（具体渠道能力见 [审核状态接入说明](docs/review-status.md)）。TestFlight 和团队协作尚未包含。

## 本次版本更新说明

新建发布时填写一份必填说明，提交到所有已选渠道。不会自动翻译；Apple 使用应用在 Connect 中的主语言，Google Play 的当前 ApkGo 适配器使用 en-US。

| 渠道 | 商店字段或提交方式 |
| --- | --- |
| 华为 | `newFeatures` |
| 荣耀 | `newFeature` |
| 小米、vivo | `updateDesc` |
| OPPO | `update_desc` |
| 魅族 | 发布请求中的版本说明 |
| 应用宝 | `feature` |
| 三星 | 在 ApkGo 上传前通过 Content Publish API 更新 `newFeature`，并回读核对 |
| Google Play | `releaseNotes[].text`，最多 500 个 Unicode 字符 |
| 蒲公英 | `buildUpdateDescription` |
| fir.im | `x:changelog` |
| Apple | 独立 metadata 目录中的 `<主语言>/release_notes.txt`，启用 metadata 上传 |

三星说明超过 4000 UTF-8 字节时拒绝创建任务；说明上传失败或回读不一致时停止该渠道。Apple 无法确认应用主语言时停止发布。Apple 首次上架是否需要“此版本的新功能”由平台及 fastlane 处理。

验证边界：已核对 ApkGo 3.7.3 的字段映射，并用隔离数据库、模拟 CLI / HTTP 验证全部 12 个渠道的执行参数、中文换行和失败拦截；尚未完成各商店真实账号的发布验收。三星绕过工具遗漏所用的接口依据：[官方说明](https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/content-publish-api/reference.html)；Apple metadata 格式依据：[fastlane 文档](https://docs.fastlane.tools/actions/deliver/)。

## 环境要求

- Node.js 22.5 或更高版本（使用内置 `node:sqlite`）
- Android 发布：[apkgo](https://github.com/KevinGong2013/apkgo) v4.2.4 或更高版本（本机已验证 v4.2.4）
- iOS 发布：macOS 与 [fastlane](https://docs.fastlane.tools/actions/deliver/)

`apkgo` 的 PolyForm Noncommercial License 仅允许非商业用途免费使用。商业场景请先取得作者授权。

### 小米查询限流

小米[自动发布接口文档](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1134)没有列出 `-20035` 的具体限流阈值。2026-10-24 使用本机账号只读实测：ApkGo v3.7.3 第一次查询成功，紧接着第二次返回 `[-20035] 请求频率太快`；查询阶段失败时尚未上传 APK。

[ApkGo v4.2.4 的小米实现](https://github.com/KevinGong2013/apkgo/blob/v4.2.4/pkg/store/xiaomi/xiaomi.go)对该错误仅重试只读 `/dev/query`，分别等待 2 秒、5 秒。这是工具的退避策略，不是小米公布的调用间隔。使用同一账号连续查询两次，新版均成功，第二次耗时约 2.3 秒。ReleasePort 的版本检查后，上传工具内部仍会查询一次，因此运行环境需要包含这项修复。此验证没有执行上传或提交审核。

### 渠道发布图标

自动沿 APK 内 `AndroidManifest.xml` 的 `application.icon` 和 `resources.arsc` 解析图标路径，不依赖移动项目源码或已同步的商店图标，不需要手动上传。自适应图标优先于同名旧版位图：按包内配置读取背景、前景，按 Android 的可见区域生成 PNG；普通位图则直接转换。图标以 APK 的 SHA-256 缓存在 `data/package-icons/`，新建发布显示预览，执行时按渠道规格准备图标并记录事件。

华为（216×216 PNG，≤500KB）、荣耀（512×512 PNG，≤200KB）、小米、OPPO（512×512 PNG，<1MB）、魅族使用按商店覆盖的 `--listing`，不会把同一份配置传给可选图标渠道。fir.im 按官方流程单独上传 `cert.icon`，确认 `is_completed=true` 后才允许工具继续上传安装包。详见 [12 个渠道图标核对表](docs/store-icon-audit.md)。

目前支持自适应图标的位图与纯色图层。遇到尚不支持的矢量或其他图层时停止需要显式图标的渠道并显示错误，不会回退到可能错误的旧版图标；其他渠道仍正常执行。已用本机真实 APK 验证资源解析、预览接口及 ApkGo dry-run 参数校验，尚未重新提交商店。自适应图标结构与尺寸依据：[Android 官方文档](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)。

## 启动

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:4173>。本地 API 监听 <http://127.0.0.1:8787>。

菜单独立地址为 `/`、`/apps`、`/releases`、`/credentials`、`/settings`，支持直接打开、刷新和浏览器前进/后退。

发布任务的“已提交”表示执行工具已成功提交。后台每 15 分钟查询已提交任务，任务详情可手动“同步审核状态”（同应用至少间隔 60 秒）。Android 复用 ApkGo audit，Apple、Google Play 与荣耀直接调用官方 API；只有版本和构建号匹配时才更新本次任务，并展示查询来源、说明、时间和错误。查询失败保留上次审核结果和上传日志。小米未开放审核/撤回查询接口，不把版本差异解释成审核中或驳回。完整支持范围和拒绝原因限制见 [审核状态接入说明](docs/review-status.md)。如果已在商店后台取消，可在任务详情点击“已在商店取消，更新记录”，将本地渠道/任务记录为“已取消”；此操作不调用商店撤回接口，保留原上传时间和日志，并记录“用户确认”来源。取消旧任务不会覆盖同应用、同渠道后续新任务的状态或已上架版本。

如需加载演示应用：

```bash
RELEASE_PORT_SEED_DEMO=true npm run dev
```

## 生产构建

```bash
npm run check
npm run build
npm start
```

`npm start` 会在 `8787` 端口提供 API，并托管 `dist/` 中的前端文件。

## 本地数据

- `data/release-port.db`：应用、版本、任务与脱敏日志
- `data/.vault-key`：本地随机加密密钥，权限为 `0600`
- `uploads/`：待发布安装包

上述路径已加入 `.gitignore`。不要提交真实安装包或凭证库文件。

## 安全边界

- 服务默认只监听 `127.0.0.1`。
- 平台密钥由后台加密保存；打开“查看 / 编辑凭证”时读取本机原文，默认隐藏，点击“显示明文”可查看。编辑时保留原有值，无需重填全部密钥；原文不写入浏览器存储。
- Android 密钥通过 stdin 传给 `apkgo`，不写入 YAML 或环境变量。
- 华为 Service Account JSON 在执行前于内存中转为 Base64；Google Play JSON 仅生成权限为 `0600` 的任务临时文件，任务结束立即删除。
- iOS 临时 API Key 文件权限为 `0600`，任务结束后删除。
- 子进程使用参数数组启动，不拼接 shell 命令。
