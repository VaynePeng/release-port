# 提交后的审核状态同步

核查日期：2026-10-24。当前实现与平台能力分开记录；“接口已实现”不等于“用真实账号验证”。

## 渠道覆盖

| 渠道 | 当前接入 | 拒绝原因/说明 | 任务匹配与限制 |
| --- | --- | --- | --- |
| 华为 Android | ApkGo audit：审核中、通过、驳回、撤回/下架 | 当前适配器仅返回 releaseState，完整原因到 AGC 查看 | versionName + versionCode 匹配 |
| OPPO | ApkGo audit：审核中、通过、驳回、撤回 | 展示 audit_status_name 与 refuse_reason | versionName + versionCode 匹配；开发者撤审与拒绝分开 |
| vivo | ApkGo audit：审核中、通过、驳回、撤回 | 当前适配器不返回具体原因，后台查看 | 有版本名和构建号时才能更新具体任务 |
| 魅族 | ApkGo audit：审核中、通过、驳回、下架 | 返回状态文字，完整原因后台查看 | 当前输出只有版本名，任务有构建号时保留提交状态；应用渠道可展示结果 |
| 应用宝 | ApkGo audit：审核状态 | 展示工具实际返回 detail，不承诺正文完整 | 审核接口未返回版本标识，仅展示应用渠道结果，不能归属具体任务 |
| 三星 | ApkGo audit：审核中、通过、拒绝、撤回 | 当前输出是 contentStatus，原因后台查看 | 使用配置的 content_id；版本名和构建号匹配 |
| 荣耀 | 直接调用官方 get-audit-result 查询审核中、通过、拒绝 | 展示 auditMessage | 从 ApkGo 最终 done.results 保存 external_id（releaseId），用 packageName 精确查询 appId 后按 releaseId 查询；旧任务没有 ID 时仅查询上架版本 |
| 小米 | 查询版本；审核状态显示未知 | 公开 API 不提供审核状态和原因 | 不从新旧版本差异推断审核中、拒绝或撤回 |
| Apple | 直接使用 App Store Connect API，查询 iOS App Store 版本及关联 build | API 可识别 REJECTED/METADATA_REJECTED；公开 API 无 Resolution Center 拒绝消息正文，App 审核后台查看 | Bundle ID 精确查找、versionString + build.version 匹配；没有 Apple 凭证时仅用 Lookup 获取公开线上版本 |
| Google Play | 直接使用 applications.tracks.releases.list 官方 API | NOT_APPROVED 可识别；返回结构无拒绝原因正文，Play Console 查看 | package_name 精确校验、配置轨道（默认 production）、activeArtifacts.versionCode 匹配；releaseName 不能当版本名 |
| 蒲公英 | 当前未接入审核查询 | 到分发后台查看 | 不把上传完成等同于正式应用商店审核通过 |
| fir.im | 当前未接入审核查询 | 到分发后台查看 | 不把上传完成等同于正式应用商店审核通过 |

`approved` 只表示通过审核，不等于已经对用户上架。除官方明确返回已发布的 Apple/Google 状态外，保留审核通过语义。ApkGo 的 `withdrawn` 可能包含撤回和下架，界面显示“已撤回 / 下架”。

## 接入行为

- 后台每 15 分钟查询最新任务仍待处理、且适配器支持审核查询的应用；小米与缺少 releaseId 的荣耀旧任务仅支持手动版本查询；不依赖浏览器打开。进程关闭时不会查询。
- 应用详情的“同步商店状态”和发布详情的“同步审核状态”共用查询，同应用并发请求合并，最小间隔 60 秒。
- 页面每 10 秒读取本地记录，不会每 10 秒请求商店。
- 商店 API 通常只返回最近版本，只允许更新同应用同渠道最新任务，并要求版本和构建号对应。旧任务、同版本旧重试、用户确认取消的任务都不会被覆盖。
- 审核结果独立保存 review_status/detail/source/checked_at/sync_error；匹配成功后再回写任务状态及审计事件。执行阶段、上传字节、开始/结束时间保持原始执行证据。
- 查询失败或 API 返回未知枚举时保留本次任务先前确认的审核状态，界面显示最近查询失败；不会把网络或鉴权失败当成审核拒绝。
- Apple 分页限定官方域名；Google 固定官方 OAuth 和 API 域名，密钥通过本地 vault 读取，响应不写入 token 或密钥。错误与说明按现有日志规则脱敏。

## 开源方案与官方资料

1. [ApkGo](https://github.com/KevinGong2013/apkgo)：已有 Android audit 统一模型；本机版本 4.2.4。复用其商店适配，不引入第二个上传引擎。该项目使用 PolyForm Noncommercial，沿用项目现有许可约束。
2. [fastlane spaceship](https://github.com/fastlane/fastlane/blob/master/spaceship/lib/spaceship/connect_api/models/app_store_version.rb)：有 Apple 状态模型；本项目已有 JWT 签名，直接调用 Apple 官方只读 API，无须新增 Ruby 子进程。
3. [App Store Connect CLI 的 API 边界记录](https://github.com/rorkai/App-Store-Connect-CLI/blob/main/docs/API_NOTES.md)：公开 API 无 Resolution Center 表面；项目另有依赖网页登录会话的 web 命令。当前未引入浏览器 cookie、双重认证会话和私有接口自动化。
4. [Apple 版本查询](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-appstoreversions)、[App 和提交内容状态](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-and-submission-statuses)。注意 appStoreReviewDetail 是开发者提交给审核人员的信息，不是拒绝消息。
5. [Google release lifecycle 模型](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases)、[查询接口](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list)：新接口明确支持 IN_REVIEW、APPROVED_NOT_PUBLISHED、NOT_APPROVED、PUBLISHED。旧 edits.tracks 的 draft/inProgress/completed 是投放状态，不用于推断审核结果。
6. [小米自动发布官方文档](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1134)：查询返回 packageInfo/versionName/versionCode，不能取得审核原因。该限制无法通过更换 CLI 弥补。
7. [荣耀发布 API 入口](https://developer.honor.com/cn/doc/guides/101360)、[OPPO 传包入口](https://open.oppomobile.com/new/developmentDoc/info?id=10998)。本次 Android 字段契约同时检查本机 ApkGo 4.2.4 源码与回放测试。

## 验证记录

- 新增荣耀 done.results 提交 ID 提取、精确 appId/releaseId 查询、拒绝原因映射与错误包名测试。
- 新增 Apple/Google 官方请求及响应映射测试，覆盖关联 build、未知状态、拒绝说明边界、鉴权失败、Apple 分页域名校验、Google 包名/轨道/构建号。
- 数据库测试覆盖版本/构建精确匹配、旧任务保护、用户取消保护、日志脱敏、结果去重、失败保留审核结果和执行历史。
- 2026-10-24 使用现有小米凭证实际只读查询成功：返回线上版本 1.4.1；界面数据记录为“审核状态未知”，没有伪造审核中/已通过。Apple Lookup 实查线上版本同为 1.4.1。
- 使用独立临时数据库完成浏览器检查：任务列表、详情中的驳回说明、查询来源、查询时间及审计事件可见；页面检查使用明确标注的隔离测试数据。
- 本机仅配置小米凭证；Apple App Store Connect、Google Play 和其他 Android 渠道未做真实账号审核结果验收，当前为请求契约与隔离测试验证。

后续要自动获取小米完整结果，需平台开放审核接口，或在已登录开发者后台建立单独的浏览器会话采集方案；仅有当前 API 密钥无法实现。荣耀新任务已补齐上传结果 releaseId 的保存及官方 API 查询；旧任务缺失的 ID 不能通过版本号猜测补录。
