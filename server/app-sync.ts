import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db } from './db.ts'
import { getToolStatus } from './tools.ts'
import { decryptSecret } from './vault.ts'
import { applyReviewObservation, matchesSubmission, type ReviewObservation } from './review-status.ts'
import { queryAppleReview } from './apple-review.ts'
import { queryGoogleReview } from './google-review.ts'
import { queryHonorReview } from './honor-review.ts'
import { sanitizeReleaseLog } from './release-logs.ts'

const androidStores = ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung', 'googleplay', 'pgyer', 'fir'] as const
const auditableStores = new Set(['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung'])

type AppRow = { id: string; android_package_name: string | null; ios_bundle_id: string | null }
export type AuditStoreResult = {
  store: string
  supported: boolean
  state?: string
  detail?: string
  error?: string
  version_name?: string
  version_code?: number
  live_version_name?: string
  live_version_code?: number
}

function upsertChannel(appId: string, store: string, platform: 'android' | 'ios', values: { online?: string | null; review?: string | null; status: string; raw?: string }) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO app_channels
      (id, app_id, store, platform, online_version, review_version, status, raw_status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_id, store) DO UPDATE SET
      online_version = COALESCE(excluded.online_version, app_channels.online_version),
      review_version = excluded.review_version,
      status = excluded.status,
      raw_status = excluded.raw_status,
      last_synced_at = excluded.last_synced_at
  `).run(crypto.randomUUID(), appId, store, platform, values.online ?? null, values.review ?? null, values.status, values.raw ?? null, now)
}

async function syncAppleLookup(app: AppRow, updatedStores: string[], warnings: string[]) {
  if (!app.ios_bundle_id) return
  try {
    const query = new URLSearchParams({ bundleId: app.ios_bundle_id, country: 'cn' })
    const response = await fetch(`https://itunes.apple.com/lookup?${query}`, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`Apple Lookup HTTP ${response.status}`)
    const payload = await response.json() as { results?: Array<{ version?: string; artworkUrl512?: string; trackViewUrl?: string }> }
    const result = payload.results?.[0]
    if (!result?.version) {
      warnings.push('Apple App Store 未找到该 Bundle ID')
      return
    }
    if (result.artworkUrl512) {
      const iconResponse = await fetch(result.artworkUrl512, { signal: AbortSignal.timeout(12_000) })
      if (iconResponse.ok) {
        const iconDir = path.join(config.dataDir, 'app-icons')
        mkdirSync(iconDir, { recursive: true, mode: 0o700 })
        const iconPath = path.join(iconDir, `${app.id}.jpg`)
        writeFileSync(iconPath, Buffer.from(await iconResponse.arrayBuffer()), { mode: 0o600 })
        db.prepare('UPDATE apps SET icon_path = ?, updated_at = ? WHERE id = ?').run(iconPath, new Date().toISOString(), app.id)
      }
    }
    upsertChannel(app.id, 'apple', 'ios', { online: result.version, status: 'live', raw: '来源：Apple Lookup（仅公开上架版本；未配置 Apple 凭证，无法查询审核状态）' })
    updatedStores.push('apple')
  } catch (error) {
    warnings.push(`Apple App Store 同步失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

export function getCredential(provider: string) {
  const row = db.prepare('SELECT encrypted_payload FROM credentials WHERE provider = ?').get(provider) as { encrypted_payload: string } | undefined
  if (!row) return null
  const payload = decryptSecret(row.encrypted_payload)
  const normalized = Object.fromEntries(Object.entries(payload).filter(([, value]) => value.trim() !== ''))
  if (provider === 'huawei' && normalized.service_account_json) {
    JSON.parse(normalized.service_account_json)
    normalized.service_account = Buffer.from(normalized.service_account_json).toString('base64')
    delete normalized.service_account_json
  }
  return normalized
}

export async function runApkgoAudit(packageName: string, stores: Record<string, Record<string, string>>) {
  const names = Object.keys(stores)
  return new Promise<AuditStoreResult[]>((resolve, reject) => {
    const child = spawn('apkgo', ['audit', '-p', packageName, '-s', names.join(','), '--creds-from=stdin', '-o', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('商店版本查询超时')) }, 45_000)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ stores }))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.resume()
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 ApkGo 版本查询')) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const report = JSON.parse(stdout) as { stores?: AuditStoreResult[] }
        resolve(report.stores ?? [])
      } catch {
        reject(new Error('ApkGo 未返回有效审核状态'))
      }
    })
  })
}

export function androidObservation(result: AuditStoreResult): ReviewObservation {
  const status = result.error || !result.supported ? 'unknown'
    : result.store === 'xiaomi' || result.store === 'honor' ? 'unknown' : result.state || 'unknown'
  return {
    store: result.store, status, source: 'apkgo_audit', version: result.version_name,
    build: result.version_code ? String(result.version_code) : undefined,
    onlineVersion: result.live_version_name,
    detail: result.store === 'xiaomi' ? '小米公开接口不提供审核状态和拒绝原因；仅查询版本，需在小米后台查看审核结果'
      : result.store === 'honor' ? '当前 ApkGo CLI 未传递 releaseId，仅能查询上架版本；审核结果及原因需在荣耀后台查看'
        : result.detail || (result.supported ? '商店未返回详细审核说明' : '当前适配器不支持审核查询'),
    error: result.error,
  }
}

async function syncApple(app: AppRow, updatedStores: string[], warnings: string[]) {
  if (!app.ios_bundle_id) return
  const credential = getCredential('apple')
  if (!credential) { await syncAppleLookup(app, updatedStores, warnings); return }
  try {
    const results = await queryAppleReview(credential, app.ios_bundle_id)
    if (!results.length) throw new Error('Apple 尚未创建 App Store 版本')
    const latest = db.prepare(`SELECT r.version_name,r.build_number FROM releases r JOIN release_targets t ON t.release_id=r.id
      WHERE r.app_id=? AND t.store='apple' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(app.id) as { version_name: string; build_number: string | null } | undefined
    const observation = (latest && results.find((row) => matchesSubmission(latest, row))) || results[0]
    const live = results.find((row) => row.status === 'live')
    upsertChannel(app.id, 'apple', 'ios', { online: live?.version, review: observation.status === 'live' ? null : observation.version,
      status: observation.status, raw: observation.detail })
    applyReviewObservation(app.id, observation, Object.values(credential))
    updatedStores.push('apple')
  } catch (error) {
    const message = sanitizeReleaseLog(error instanceof Error ? error.message : 'Apple 查询失败', Object.values(credential))
    warnings.push(message)
    applyReviewObservation(app.id, { store: 'apple', status: 'unknown', detail: '查询失败，保留上次审核结果', source: 'app_store_connect', error: message })
  }
}

async function syncGoogle(app: AppRow, updatedStores: string[], warnings: string[]) {
  if (!app.android_package_name) return
  const credential = getCredential('googleplay')
  if (!credential) return
  try {
    const results = await queryGoogleReview(credential, app.android_package_name)
    if (!results.length) throw new Error('Google Play 当前轨道未返回有效版本')
    const latest = db.prepare(`SELECT r.version_name,r.build_number FROM releases r JOIN release_targets t ON t.release_id=r.id
      WHERE r.app_id=? AND t.store='googleplay' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(app.id) as { version_name: string; build_number: string | null } | undefined
    const observation = (latest && results.find((row) => matchesSubmission(latest, row))) || results[0]
    if (latest && matchesSubmission(latest, observation)) observation.version = latest.version_name
    upsertChannel(app.id, 'googleplay', 'android', { review: observation.status === 'live' ? null : observation.version,
      status: observation.status, raw: observation.detail })
    applyReviewObservation(app.id, observation, Object.values(credential))
    updatedStores.push('googleplay')
  } catch (error) {
    const message = sanitizeReleaseLog(error instanceof Error ? error.message : 'Google Play 查询失败', Object.values(credential))
    warnings.push(message)
    applyReviewObservation(app.id, { store:'googleplay',status:'unknown',detail:'查询失败，保留上次审核结果',source:'google_play_api',error:message })
  }
}

function latestHonor(appId: string) {
  return db.prepare(`SELECT t.external_id FROM release_targets t JOIN releases r ON r.id=t.release_id
    WHERE r.app_id=? AND t.store='honor' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(appId) as { external_id: string | null } | undefined
}
async function syncHonor(app: AppRow, updatedStores: string[], warnings: string[]) {
  const submission = latestHonor(app.id)
  if (!app.android_package_name || !submission?.external_id) return
  const credential = getCredential('honor')
  if (!credential) return
  try {
    const observation = await queryHonorReview(credential, app.android_package_name, submission.external_id)
    observation.detail = sanitizeReleaseLog(observation.detail,Object.values(credential))
    upsertChannel(app.id,'honor','android',{status:observation.status,raw:observation.detail})
    applyReviewObservation(app.id,observation,Object.values(credential))
    updatedStores.push('honor')
  } catch (error) {
    const message = sanitizeReleaseLog(error instanceof Error ? error.message : '荣耀查询失败',Object.values(credential))
    warnings.push(message)
    applyReviewObservation(app.id,{store:'honor',status:'unknown',source:'honor_api',detail:'查询失败，保留上次审核结果',error:message})
  }
}

async function syncAndroid(app: AppRow, updatedStores: string[], warnings: string[]) {
  if (!app.android_package_name) return
  // Initialize missing channels only; query failures must not erase last known state.
  for (const store of androidStores) db.prepare(`INSERT OR IGNORE INTO app_channels (id,app_id,store,platform,status,raw_status)
    VALUES (?,?,?,'android','unverified',?)`).run(crypto.randomUUID(), app.id, store,
      auditableStores.has(store) || store === 'googleplay' ? '尚未同步' : '当前渠道未接入审核状态查询，请在商店后台查看')
  if (!getToolStatus().find(({ name }) => name === 'apkgo')?.installed) {
    warnings.push('尚未安装 ApkGo，Android 商店版本未同步。请前往“运行设置”按指引安装')
    return
  }
  const stores: Record<string, Record<string, string>> = {}
  for (const store of auditableStores) {
    if (store === 'honor' && latestHonor(app.id)?.external_id) continue
    try {
      const credential = getCredential(store)
      if (credential) stores[store] = credential
    } catch { warnings.push(`${store} 凭证格式不正确`) }
  }
  if (!Object.keys(stores).length) {
    if (!getCredential('googleplay') && !(latestHonor(app.id)?.external_id && getCredential('honor'))) warnings.push('尚未配置支持状态查询的 Android 商店凭证')
    return
  }
  const secrets = Object.values(stores).flatMap(Object.values)
  try {
    const results = await runApkgoAudit(app.android_package_name, stores)
    for (const store of Object.keys(stores)) {
      const result = results.find((row) => row.store === store) ?? { store, supported: false, error: 'ApkGo 未返回该渠道结果' }
      const observation = androidObservation(result)
      observation.detail = sanitizeReleaseLog(observation.detail, secrets)
      if (observation.error) {
        observation.error = sanitizeReleaseLog(observation.error, secrets)
        warnings.push(`${store}：${observation.error}`)
      } else {
        upsertChannel(app.id, store, 'android', { online: observation.onlineVersion,
          review: store === 'xiaomi' || store === 'honor' ? null : observation.version,
          status: observation.status, raw: observation.detail })
        updatedStores.push(store)
      }
      applyReviewObservation(app.id, observation, secrets)
    }
  } catch (error) {
    const message = sanitizeReleaseLog(error instanceof Error ? error.message : '未知错误', secrets)
    warnings.push(`ApkGo 状态同步失败：${message}`)
    for (const store of Object.keys(stores)) applyReviewObservation(app.id, { store, status: 'unknown', detail: '查询失败，保留上次审核结果', source: 'apkgo_audit', error: message })
  }
}

const inFlight = new Map<string, Promise<{ updatedStores: string[]; warnings: string[] }>>()
const lastAttempts = new Map<string, number>()
export function syncApp(appId: string) {
  const running = inFlight.get(appId)
  if (running) return running
  const app = db.prepare('SELECT id, android_package_name, ios_bundle_id FROM apps WHERE id = ?').get(appId) as AppRow | undefined
  if (!app) return Promise.reject(new Error('应用不存在'))
  if (Date.now() - (lastAttempts.get(appId) ?? 0) < 60_000) return Promise.resolve({ updatedStores: [], warnings: ['查询间隔至少 60 秒，请稍后重试，避免商店限流'] })
  lastAttempts.set(appId, Date.now())
  const work = (async () => {
    const updatedStores: string[] = []
    const warnings: string[] = []
    await Promise.all([syncApple(app, updatedStores, warnings), syncAndroid(app, updatedStores, warnings), syncGoogle(app, updatedStores, warnings), syncHonor(app, updatedStores, warnings)])
    return { updatedStores, warnings }
  })().finally(() => inFlight.delete(appId))
  inFlight.set(appId, work)
  return work
}

export function startReviewScheduler() {
  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      const apps = db.prepare(`SELECT DISTINCT r.app_id FROM releases r JOIN release_targets t ON t.release_id=r.id
        WHERE r.status NOT IN ('queued','scheduled','running') AND t.status IN ('submitted','reviewing','approved','pending_developer_release')
        AND (t.store IN ('huawei','oppo','vivo','meizu','tencent','samsung','apple','googleplay') OR (t.store='honor' AND t.external_id IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM release_targets newer JOIN releases nr ON nr.id=newer.release_id
          WHERE nr.app_id=r.app_id AND newer.store=t.store AND (nr.created_at>r.created_at OR (nr.created_at=r.created_at AND nr.rowid>r.rowid)))`).all() as Array<{ app_id: string }>
      for (const app of apps) await syncApp(app.app_id).catch(() => {})
    } finally { running = false }
  }
  // Review takes hours; a 15-minute interval avoids aggressive vendor polling.
  const timer = setInterval(() => void tick(), 15 * 60_000)
  timer.unref()
  return timer
}
