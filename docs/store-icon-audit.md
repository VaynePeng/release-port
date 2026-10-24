# 发布图标接口核对

核对日期：2026-10-24。工具版本：ApkGo v4.2.4。区分“商店资料必须有图标”和“更新请求每次必须重新上传图标”。本表覆盖 ReleasePort 当前 12 个渠道，不包含未接入的鸿蒙发布。

| 渠道 | 官方接口/资料要求及当前工具行为 | ReleasePort 处理 |
| --- | --- | --- |
| 华为 | 发布前需要已配置图标等视觉素材；工具允许单独更新语言级图标。已有应用更新可复用既有素材，不等于每次都必须重传 | 为必需素材提供包内图标，生成当前适配器要求的 216×216 PNG、≤500KB，通过 `app-file-info` 绑定 |
| 荣耀 | 文件类型表：应用图标是必选素材，512×512、≤200KB，需关联语言；已有绑定可复用 | 自动提供包内图标，经工具上传、绑定到当前语言 |
| 小米 | `/dev/push` 的 `icon` 是必传文件，更新也传；工具默认使用旧版位图，会覆盖原图 | 显式提供按 APK 配置解析的完整图标，512×512 PNG |
| OPPO | `/app/upd` 的 `icon_url` 必传，512×512 PNG、<1MB；工具原先回填旧图，校验不合格时提取 APK 旧版位图替换 | 自动上传正确包内图标，工具将上传后的 URL 填入更新请求 |
| 魅族 | 发布参数 `icon` 必填，为图片上传接口返回的路径；工具原先回填旧图，没有旧图时提取 APK 旧版位图 | 显式上传正确包内图标，由工具填入图片路径。使用 512×512 PNG；官方接口未规定此字段的像素大小，512 是当前工具策略 |
| vivo | 应用更新接口（doc/343）`icon` 标为“否”，传图标上传流水号才更换 | 不额外传图标，保留商店现有图标 |
| 应用宝 | 更新接口 `icon_file_serial_number` 标为“否”，注明“不变更则不填” | 不额外传图标，保留商店现有图标 |
| 三星 | `contentUpdate` 的必填项是 `contentId/defaultLanguageCode/paid/publicationType`；替换图标时才传 `iconKey` | 不额外传图标，保留商店现有图标 |
| Google Play | 发布版本通过 edits/tracks；商店图标通过独立的 edits/images 管理；已有商店资料可复用 | 不额外调用图片接口 |
| 蒲公英 | 官方上传参数没有独立图标必填项；服务端解析包体并返回 `buildIcon` | 上传安装包，交由服务端解析 |
| fir.im | 官方发布流程要求图标、安装包分别传至 `cert.icon`、`cert.binary`；当前 ApkGo 只实现 binary 上传，不支持图标 listing | 补充独立图标上传，确认完成后才启动 ApkGo；缺失 cert.icon 或上传未完成则停止该渠道 |
| Apple | 图标在 Xcode 资产/构建内，上传构建后由 App Store Connect 处理；不是 deliver 的独立必填图片字段 | 随 IPA 上传，不额外附加 Android 图标 |

## 来源

- [华为正式发布流程（Android Publishing API）](https://developer.huawei.com/consumer/ru/doc/AppGallery-connect-Guides/agcapi-release_app-0000001111685460)：发布前配置视觉素材。216×216/500KB 为当前 ApkGo Android 图标校验规格，不套用 HarmonyOS 5 的素材表。
- [荣耀 API 传包指引](https://developer.honor.com/cn/doc/guides/101359)：文件类型表、语言关联和必选图标。
- [小米自动发布接口](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1134)：`/dev/push` 的 icon。
- [OPPO 更新资料](https://open.oppomobile.com/documentation/page/info?id=11000)：icon_url 必传及尺寸、大小。通过浏览器读取正文。
- [魅族 API 传包文档 v1.07](https://open.flyme.cn/docs?id=333)：icon 必填、图片上传接口返回路径。通过浏览器读取正文。
- [vivo 应用更新](https://dev.vivo.com.cn/documentCenter/doc/343)：icon 可选。通过浏览器读取正文。
- [应用宝开放 API](https://wikinew.open.qq.com/index.html#/iwiki/4015262492)：icon_file_serial_number 可选、不变更则不填。通过浏览器读取正文。
- [三星 Modify App Data](https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/content-publish-api/modify-app-data.html)、[字段定义](https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/content-publish-api/reference.html)。
- [Google Play tracks.update](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/update)、[images.upload](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/upload)。
- [蒲公英上传与发布](https://www.pgyer.com/doc/view/api_upload)。
- [fir.im 发布应用](https://www.betaqr.com.cn/docs/publish)。
- [Apple 添加应用图标](https://developer.apple.com/help/app-store-connect/manage-app-information/add-an-app-icon/)。
- [当前 ApkGo v4.2.4 适配器](https://github.com/KevinGong2013/apkgo/tree/v4.2.4/pkg/store)：逐一核对上传字段、图标回填、listing 覆盖和默认提取行为。

## 验证边界

- 隔离数据库、模拟 CLI：验证五个商店的 listing 覆盖、华为尺寸、图标损坏时阻止相关渠道并保留其他渠道。
- 模拟 HTTP：验证 fir.im 请求 cert.icon、multipart 文件和服务端完成确认；不向真实平台上传。
- 真实 APK：五个 listing 渠道的输出尺寸、字节数、格式已逐一对照当前 CLI schema；华为（模拟 Service Account）和小米通过当前 ApkGo dry-run。荣耀/OPPO/魅族的构造函数会在 dry-run 前请求鉴权，此处未使用真实账号鉴权，不宣称这三个渠道的真实 CLI dry-run 通过。dry-run 不是平台验收。
- fir.im、Google Play、蒲公英目前仍受既有线上版本校验能力限制（当前 audit 适配器不支持），此改动不绕过版本校验，不代表这三个渠道已完成真实发布闭环。
- 本次没有执行任何真实上传、送审或更换商店图标。
