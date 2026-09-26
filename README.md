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

当前未包含商店状态自动轮询、安装包元数据自动解析、TestFlight 和团队协作。这些属于下一阶段。

## 环境要求

- Node.js 22.5 或更高版本（使用内置 `node:sqlite`）
- Android 发布：[apkgo](https://github.com/KevinGong2013/apkgo)
- iOS 发布：macOS 与 [fastlane](https://docs.fastlane.tools/actions/deliver/)

`apkgo` 的 PolyForm Noncommercial License 仅允许非商业用途免费使用。商业场景请先取得作者授权。

## 启动

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:4173>。本地 API 监听 <http://127.0.0.1:8787>。

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
- 平台密钥由后台加密保存，前端不会读取保存后的原文。
- Android 密钥通过 stdin 传给 `apkgo`，不写入 YAML 或环境变量。
- 华为 Service Account JSON 在执行前于内存中转为 Base64；Google Play JSON 仅生成权限为 `0600` 的任务临时文件，任务结束立即删除。
- iOS 临时 API Key 文件权限为 `0600`，任务结束后删除。
- 子进程使用参数数组启动，不拼接 shell 命令。
