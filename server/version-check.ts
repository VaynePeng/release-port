import { getCredential, runApkgoAudit, type AuditStoreResult } from './app-sync.ts'
import { compareVersions, type PackageMetadata } from './package-metadata.ts'
import { jwt } from './release-notes.ts'

export type VersionCheck = { store: string; status: 'passed' | 'blocked'; message: string; versionName?: string; buildNumber?: string }
const audited = new Set(['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung'])

export function checkAndroidBaseline(metadata: PackageMetadata, result: AuditStoreResult): VersionCheck {
  const fail = (message: string): VersionCheck => ({ store: result.store, status: 'blocked', message })
  if (!result.supported || result.error) return fail('无法取得该商店的有效版本信息，请先检查凭证和商店同步状态')
  const baselines = [
    { name: result.live_version_name, code: result.live_version_code },
    { name: result.version_name, code: result.version_code },
  ].filter((item) => item.name || item.code)
  if (!baselines.length) return fail('商店未返回可比较的版本，无法确认是首次上架还是查询数据不完整')
  if (!/^\d+$/.test(metadata.buildNumber)) return fail('安装包 versionCode 不是有效整数')
  if (!baselines.some(({ code }) => Number.isSafeInteger(code) && Number(code) > 0)) return fail('商店未返回 versionCode，无法完成构建号校验')
  for (const baseline of baselines) {
    if (baseline.name && compareVersions(metadata.versionName, baseline.name) === -1) return fail(`安装包版本 ${metadata.versionName} 低于商店版本 ${baseline.name}`)
    if (baseline.code && BigInt(metadata.buildNumber) <= BigInt(baseline.code)) return fail(`安装包构建号 ${metadata.buildNumber} 必须大于商店已有构建号 ${baseline.code}，不能降级或重复上传`)
  }
  const latest = baselines.reduce((a, b) => (a.code ?? 0) >= (b.code ?? 0) ? a : b)
  return { store: result.store, status: 'passed', message: '版本与构建号校验通过', versionName: latest.name, buildNumber: latest.code ? String(latest.code) : undefined }
}

async function checkApple(metadata: PackageMetadata): Promise<VersionCheck> {
  const credential = getCredential('apple')
  if (!credential) throw new Error('未配置 Apple 凭证，无法校验线上构建号')
  const now = Math.floor(Date.now() / 1000)
  const token = jwt({ alg: 'ES256', kid: credential.key_id, typ: 'JWT' }, { iss: credential.issuer_id, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }, credential.private_key, 'sha256')
  async function read(url: string) {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://api.appstoreconnect.apple.com') throw new Error('Apple 返回了无效分页地址')
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Apple 版本查询失败（HTTP ${response.status}）`)
    return response.json() as Promise<{ data: Array<{ id: string; attributes: Record<string, string>; relationships?: { preReleaseVersion?: { data?: { id: string } } } }>; included?: Array<{ id: string; type: string; attributes: Record<string, string> }>; links?: { next?: string } }>
  }
  const apps = await read(`https://api.appstoreconnect.apple.com/v1/apps?${new URLSearchParams({ 'filter[bundleId]': metadata.packageName, limit: '2' })}`)
  if (apps.data?.length !== 1 || apps.data[0].attributes.bundleId !== metadata.packageName) throw new Error('无法确认 Apple 应用，不能校验版本')
  const appId = apps.data[0].id
  const baselines: Array<{ version: string; build?: string }> = []
  const versions = await read(`https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?limit=200`)
  for (const version of versions.data) if (version.attributes.versionString) baselines.push({ version: version.attributes.versionString })
  if (versions.links?.next) throw new Error('Apple 版本记录过多，未完成全量校验')
  let url: string | undefined = `https://api.appstoreconnect.apple.com/v1/builds?${new URLSearchParams({ 'filter[app]': appId, include: 'preReleaseVersion', limit: '200' })}`
  for (let page = 0; url && page < 20; page++) {
    const report = await read(url)
    for (const build of report.data) {
      const trainId = build.relationships?.preReleaseVersion?.data?.id
      const train = report.included?.find((item) => item.type === 'preReleaseVersions' && item.id === trainId)
      if (!train?.attributes.version || !build.attributes.version) throw new Error('Apple 未返回构建所属版本，无法完整校验')
      baselines.push({ version: train.attributes.version, build: build.attributes.version })
    }
    url = report.links?.next
  }
  if (url) throw new Error('Apple 构建记录过多，未完成全量校验')
  for (const baseline of baselines) {
    const comparison = compareVersions(metadata.versionName, baseline.version)
    if (comparison === null) throw new Error('Apple 版本号不是可比较的数字版本')
    if (comparison < 0) throw new Error(`安装包版本 ${metadata.versionName} 低于 Connect 已有版本 ${baseline.version}`)
    if (comparison === 0 && baseline.build) {
      const buildComparison = compareVersions(metadata.buildNumber, baseline.build)
      if (buildComparison === null || buildComparison <= 0) throw new Error(`版本 ${baseline.version} 的构建号必须大于 Connect 已有构建号 ${baseline.build}`)
    }
  }
  return { store: 'apple', status: 'passed', message: '已校验 Connect 版本和构建记录' }
}

export async function checkPackageVersions(metadata: PackageMetadata, selectedStores: string[]): Promise<VersionCheck[]> {
  if (metadata.platform === 'ios') {
    try { return [await checkApple(metadata)] }
    catch (error) { return [{ store: 'apple', status: 'blocked', message: error instanceof Error ? error.message : 'Apple 版本校验失败' }] }
  }
  const results: VersionCheck[] = []
  const credentials: Record<string, Record<string, string>> = {}
  for (const store of selectedStores) {
    if (!audited.has(store)) {
      results.push({ store, status: 'blocked', message: '当前查询适配器不支持该渠道的线上构建号校验，无法安全确认版本' })
      continue
    }
    try {
      const credential = getCredential(store)
      if (!credential) throw new Error()
      credentials[store] = credential
    } catch { results.push({ store, status: 'blocked', message: '未配置有效的渠道凭证，无法校验线上版本' }) }
  }
  if (Object.keys(credentials).length) {
    try {
      const report = await runApkgoAudit(metadata.packageName, credentials)
      for (const store of Object.keys(credentials)) {
        const row = report.find((item) => item.store === store)
        results.push(row ? checkAndroidBaseline(metadata, row) : { store, status: 'blocked', message: '商店未返回查询结果，未通过版本校验' })
      }
    } catch {
      for (const store of Object.keys(credentials)) results.push({ store, status: 'blocked', message: '线上版本查询失败或超时，请检查网络后重试' })
    }
  }
  return results
}
