import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db } from './db.ts'
import { getToolStatus } from './tools.ts'
import { decryptSecret } from './vault.ts'

const androidStores = ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung', 'googleplay', 'pgyer', 'fir'] as const
const auditableStores = new Set(['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung'])

type AppRow = { id: string; android_package_name: string | null; ios_bundle_id: string | null }
type AuditStoreResult = {
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
      review_version = COALESCE(excluded.review_version, app_channels.review_version),
      status = excluded.status,
      raw_status = excluded.raw_status,
      last_synced_at = excluded.last_synced_at
  `).run(crypto.randomUUID(), appId, store, platform, values.online ?? null, values.review ?? null, values.status, values.raw ?? null, now)
}

async function syncApple(app: AppRow, updatedStores: string[], warnings: string[]) {
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
    upsertChannel(app.id, 'apple', 'ios', { online: result.version, status: 'live', raw: JSON.stringify({ source: 'apple_lookup', url: result.trackViewUrl }) })
    updatedStores.push('apple')
  } catch (error) {
    warnings.push(`Apple App Store 同步失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function getCredential(provider: string) {
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

async function runApkgoAudit(packageName: string, stores: Record<string, Record<string, string>>) {
  const names = Object.keys(stores)
  return new Promise<AuditStoreResult[]>((resolve, reject) => {
    const child = spawn('apkgo', ['audit', '-p', packageName, '-s', names.join(','), '--creds-from=stdin', '-o', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdin.end(JSON.stringify({ stores }))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    child.on('error', reject)
    child.on('close', () => {
      try {
        const report = JSON.parse(stdout) as { stores?: AuditStoreResult[] }
        resolve(report.stores ?? [])
      } catch {
        reject(new Error(stderr || 'ApkGo 未返回有效审核状态'))
      }
    })
  })
}

async function syncAndroid(app: AppRow, updatedStores: string[], warnings: string[]) {
  if (!app.android_package_name) return
  for (const store of androidStores) upsertChannel(app.id, store, 'android', { status: 'unverified', raw: '尚未同步' })
  if (!getToolStatus().find(({ name }) => name === 'apkgo')?.installed) {
    warnings.push('尚未安装 ApkGo，Android 商店版本未同步。请前往“运行设置”按指引安装')
    return
  }
  const stores: Record<string, Record<string, string>> = {}
  for (const store of androidStores) {
    if (!auditableStores.has(store)) continue
    try {
      const credential = getCredential(store)
      if (credential) stores[store] = credential
    } catch {
      warnings.push(`${store} 凭证格式不正确`)
    }
  }
  if (!Object.keys(stores).length) {
    warnings.push('尚未配置支持状态查询的 Android 商店凭证')
    return
  }
  try {
    const results = await runApkgoAudit(app.android_package_name, stores)
    for (const result of results) {
      const status = result.error ? 'failed' : result.state || 'unverified'
      upsertChannel(app.id, result.store, 'android', {
        online: result.live_version_name || null,
        review: result.version_name || null,
        status,
        raw: result.error || result.detail || result.state,
      })
      if (!result.error) {
        updatedStores.push(result.store)
        db.prepare("UPDATE credentials SET validation_status = 'valid', last_validated_at = ? WHERE provider = ?").run(new Date().toISOString(), result.store)
      }
    }
  } catch (error) {
    warnings.push(`ApkGo 状态同步失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

export async function syncApp(appId: string) {
  const app = db.prepare('SELECT id, android_package_name, ios_bundle_id FROM apps WHERE id = ?').get(appId) as AppRow | undefined
  if (!app) throw new Error('应用不存在')
  const updatedStores: string[] = []
  const warnings: string[] = []
  await Promise.all([syncApple(app, updatedStores, warnings), syncAndroid(app, updatedStores, warnings)])
  return { updatedStores, warnings }
}
