import { createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type Credentials = Record<string, string>
type ApiFetch = typeof fetch

export function jwt(header: object, payload: object, key: string, algorithm: 'sha256' | 'RSA-SHA256') {
  const content = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = sign(algorithm, Buffer.from(content), {
    key: createPrivateKey(key), dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${content}.${signature}`
}

export async function prepareAppleReleaseNotes(credentials: Credentials, bundleId: string, notes: string, directory: string, apiFetch: ApiFetch = fetch) {
  const now = Math.floor(Date.now() / 1000)
  const token = jwt({ alg: 'ES256', kid: credentials.key_id, typ: 'JWT' }, {
    iss: credentials.issuer_id, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
  }, credentials.private_key, 'sha256')
  const query = new URLSearchParams({ 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId,primaryLocale', limit: '2' })
  const response = await apiFetch(`https://api.appstoreconnect.apple.com/v1/apps?${query}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`读取 Apple 应用主语言失败（HTTP ${response.status}），未上传更新说明`)
  const payload = await response.json() as { data?: Array<{ attributes?: { bundleId?: string; primaryLocale?: string } }> }
  const apps = payload.data?.filter(({ attributes }) => attributes?.bundleId === bundleId) ?? []
  const locale = apps.length === 1 ? apps[0].attributes?.primaryLocale : undefined
  if (!locale || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error('无法确认 Apple 应用及主语言，未上传更新说明')
  const localeDir = path.join(directory, locale)
  mkdirSync(localeDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(localeDir, 'release_notes.txt'), notes, { mode: 0o600 })
  return locale
}

// ApkGo 3.7.3 does not map ReleaseNotes into Samsung's newFeature field.
// Prepare the update draft before ApkGo attaches the binary and submits it.
export async function updateSamsungReleaseNotes(credentials: Credentials, notes: string, releaseAt: string | null, apiFetch: ApiFetch = fetch) {
  const now = Math.floor(Date.now() / 1000)
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: credentials.service_account_id, scopes: ['publishing'], iat: now, exp: now + 300,
  }, credentials.private_key, 'RSA-SHA256')
  const base = 'https://devapi.samsungapps.com'
  const auth = await apiFetch(`${base}/auth/accessToken`, {
    method: 'POST', headers: { Authorization: `Bearer ${assertion}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
  })
  if (!auth.ok) throw new Error(`三星鉴权失败（HTTP ${auth.status}）`)
  const token = (await auth.json() as { createdItem?: { accessToken?: string } }).createdItem?.accessToken
  if (!token) throw new Error('三星未返回访问令牌，未上传更新说明')
  const headers = { Authorization: `Bearer ${token}`, 'service-account-id': credentials.service_account_id, 'Content-Type': 'application/json' }
  async function read() {
    const response = await apiFetch(`${base}/seller/contentInfo?${new URLSearchParams({ contentId: credentials.content_id })}`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`读取三星应用失败（HTTP ${response.status}）`)
    const rows = await response.json() as Array<Record<string, unknown>>
    const app = Array.isArray(rows) ? rows.find((row) => String(row.contentId) === credentials.content_id) : undefined
    if (!app) throw new Error('三星未返回对应 Content ID 的应用')
    return app
  }
  const current = await read()
  const body: Record<string, unknown> = {
    contentId: credentials.content_id, newFeature: notes, publicationType: releaseAt ? '02' : '01',
  }
  for (const field of ['defaultLanguageCode', 'paid', 'usExportLaws', 'ageLimit', 'chinaAgeLimit']) {
    if (current[field] !== undefined && current[field] !== null) body[field] = current[field]
  }
  if (!body.defaultLanguageCode || body.paid === undefined) throw new Error('三星缺少必需的现有应用资料，未更新版本说明')
  if (releaseAt) {
    body.startPublicationDate = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(new Date(releaseAt))
  }
  const response = await apiFetch(`${base}/seller/contentUpdate`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`三星更新说明上传失败（HTTP ${response.status}）`)
  const result = await response.json() as { resultCode?: string }
  if (result.resultCode !== '0000') throw new Error(`三星更新说明未被接受（错误码 ${String(result.resultCode ?? '缺失')}）`)
  if ((await read()).newFeature !== notes) throw new Error('三星更新说明回读不一致，已停止该渠道发布')
}

export function releaseNotesError(notes: string, stores: string[]) {
  if (!notes.trim()) return '请填写本次版本更新说明'
  if (stores.includes('googleplay') && Array.from(notes).length > 500) return 'Google Play 版本更新说明最多 500 个字符'
  if (stores.includes('samsung') && Buffer.byteLength(notes, 'utf8') > 4000) return '三星版本更新说明最多 4000 字节，请缩短内容'
  return null
}
