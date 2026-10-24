import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { z } from 'zod'
import { config } from './config.ts'
import { db, seedDemoData } from './db.ts'
import { startScheduler } from './executor.ts'
import { validateCredential } from './credential-validation.ts'
import { releaseNotesError } from './release-notes.ts'
import { inspectPackage, verifyPackageIdentity } from './package-metadata.ts'
import { inspectPackageIcon, adaptStoreIcon } from './package-icon.ts'
import { requiredIconStores } from '../src/lib/store-icons.ts'
import { recordStoreCancellation } from './release-cancellation.ts'
import { checkPackageVersions } from './version-check.ts'
import { syncApp, startReviewScheduler } from './app-sync.ts'
import { getBootstrapData, getReleaseDetails } from './queries.ts'
import { getToolStatus } from './tools.ts'
import { decryptSecret, encryptSecret, secretFingerprint } from './vault.ts'

mkdirSync(config.uploadDir, { recursive: true })
seedDemoData()

const app = express()
const androidStores = ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung', 'googleplay', 'pgyer', 'fir'] as const
const credentialProviders = [...androidStores, 'apple'] as const
const requiredCredentialFields: Record<(typeof credentialProviders)[number], string[]> = {
  huawei: ['service_account_json'],
  honor: ['client_id', 'client_secret'],
  xiaomi: ['email', 'private_key'],
  oppo: ['client_id', 'client_secret'],
  vivo: ['access_key', 'access_secret'],
  meizu: ['client_id', 'client_secret'],
  tencent: ['user_id', 'access_secret'],
  samsung: ['service_account_id', 'private_key', 'content_id'],
  googleplay: ['json_key', 'package_name'],
  pgyer: ['api_key'],
  fir: ['api_token'],
  apple: ['issuer_id', 'key_id', 'private_key'],
}
const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
})

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.use((request, response, next) => {
  const origin = request.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    response.status(403).json({ error: '仅允许从本机访问' })
    return
  }
  response.setHeader('Cache-Control', 'no-store')
  next()
})

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, tools: getToolStatus(), now: new Date().toISOString() })
})

app.get('/api/bootstrap', (_request, response) => {
  response.json({ ...getBootstrapData(), tools: getToolStatus() })
})

app.get('/api/package-icons/:name', (request, response) => {
  if (!/^[a-f0-9]{64}\.png$/.test(request.params.name)) { response.status(404).end(); return }
  response.sendFile(path.join(config.dataDir, 'package-icons', request.params.name))
})

const appSchema = z.object({
  name: z.string().trim().min(1).max(80),
  androidPackageName: z.string().trim().max(255).optional().default(''),
  iosBundleId: z.string().trim().max(255).optional().default(''),
}).refine((value) => value.androidPackageName || value.iosBundleId, { message: '至少填写一个包标识' })

app.post('/api/apps', (request, response) => {
  const parsed = appSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数错误' })
    return
  }
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO apps (id, name, android_package_name, ios_bundle_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, parsed.data.name, parsed.data.androidPackageName || null, parsed.data.iosBundleId || null, now, now)
  response.status(201).json({ id })
  void syncApp(id)
})

app.get('/api/apps/:id/icon', (request, response) => {
  const row = db.prepare('SELECT icon_path FROM apps WHERE id = ?').get(request.params.id) as { icon_path: string | null } | undefined
  if (!row?.icon_path) {
    response.status(404).end()
    return
  }
  response.setHeader('Cache-Control', 'private, max-age=86400')
  response.sendFile(row.icon_path)
})

app.post('/api/apps/:id/sync', async (request, response) => {
  try {
    response.json(await syncApp(request.params.id))
  } catch (error) {
    response.status(404).json({ error: error instanceof Error ? error.message : '同步失败' })
  }
})

const credentialSchema = z.object({
  provider: z.enum(credentialProviders),
  label: z.string().trim().min(1).max(80),
  fields: z.record(z.string(), z.string()),
}).superRefine((value, context) => {
  for (const field of requiredCredentialFields[value.provider]) {
    if (!value.fields[field]?.trim()) context.addIssue({ code: 'custom', message: `缺少必填凭证字段：${field}`, path: ['fields', field] })
  }
  if (value.provider === 'tencent' && !value.fields.app_id?.trim() && !value.fields.app_id_map?.trim()) {
    context.addIssue({ code: 'custom', message: '腾讯应用宝需要 app_id 或 app_id_map', path: ['fields'] })
  }
  if (value.provider === 'huawei' || value.provider === 'googleplay') {
    const field = value.provider === 'huawei' ? 'service_account_json' : 'json_key'
    try {
      JSON.parse(value.fields[field] ?? '')
    } catch {
      context.addIssue({ code: 'custom', message: `${field} 必须是有效 JSON`, path: ['fields', field] })
    }
  }
})

app.post('/api/credentials', async (request, response) => {
  const parsed = credentialSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数错误' })
    return
  }
  const now = new Date().toISOString()
  const fields = Object.fromEntries(Object.entries(parsed.data.fields).filter(([, value]) => value.trim() !== ''))
  const encrypted = encryptSecret(fields)
  const fingerprint = secretFingerprint(fields)
  const existing = db.prepare('SELECT id FROM credentials WHERE provider = ?').get(parsed.data.provider) as { id: string } | undefined
  if (existing) {
    db.prepare(`
      UPDATE credentials SET label = ?, encrypted_payload = ?, fingerprint = ?, validation_status = 'unverified', validation_message = NULL, last_validated_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.label, encrypted, fingerprint, now, existing.id)
    const validation = await validateCredential(parsed.data.provider)
    response.json({ id: existing.id, fingerprint, validation })
    return
  }
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO credentials
      (id, provider, label, encrypted_payload, fingerprint, validation_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'unverified', ?, ?)
  `).run(id, parsed.data.provider, parsed.data.label, encrypted, fingerprint, now, now)
  const validation = await validateCredential(parsed.data.provider)
  response.status(201).json({ id, fingerprint, validation })
})

app.post('/api/credentials/:provider/reveal', (request, response) => {
  // Only an explicit same-origin app request may retrieve local plaintext.
  if (request.get('X-ReleasePort-Credentials') !== 'reveal') {
    response.status(403).json({ error: '请从本机凭证编辑窗口查看' })
    return
  }
  const row = db.prepare('SELECT encrypted_payload FROM credentials WHERE provider = ?').get(request.params.provider) as { encrypted_payload: string } | undefined
  if (!row) {
    response.status(404).json({ error: '尚未配置该平台凭证' })
    return
  }
  try { response.json({ fields: decryptSecret(row.encrypted_payload) }) }
  catch { response.status(500).json({ error: '无法解密本机凭证' }) }
})

app.post('/api/credentials/:provider/validate', async (request, response) => {
  if (!credentialProviders.includes(request.params.provider as (typeof credentialProviders)[number])) {
    response.status(400).json({ error: '未知凭证平台' })
    return
  }
  try { response.json(await validateCredential(request.params.provider)) }
  catch { response.status(404).json({ error: '尚未配置该平台凭证' }) }
})

app.delete('/api/credentials/:provider', (request, response) => {
  db.prepare('DELETE FROM credentials WHERE provider = ?').run(request.params.provider)
  response.status(204).end()
})

async function sha256(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

const releaseFieldsSchema = z.object({
  appId: z.string().min(1),
  platform: z.enum(['android', 'ios']),
  stores: z.string().transform((value, context) => {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error()
      return parsed as string[]
    } catch {
      context.addIssue({ code: 'custom', message: '渠道列表格式错误' })
      return z.NEVER
    }
  }),
  strategy: z.enum(['upload_only', 'automatic', 'manual', 'scheduled_release']),
  releaseNotes: z.string().trim().min(1, '请填写本次版本更新说明').max(4_000),
  submitAt: z.string().optional().default(''),
  storeReleaseAt: z.string().optional().default(''),
  timezone: z.string().min(1).default('Asia/Shanghai'),
})

app.post('/api/packages/inspect', upload.single('artifact'), async (request, response) => {
  if (!request.file) { response.status(400).json({ error: '请选择安装包' }); return }
  try {
    const metadata = await inspectPackage(request.file.path, request.file.originalname)
    let iconUrl: string | undefined
    let iconError: string | undefined
    if (path.extname(request.file.originalname).toLowerCase() === '.apk') {
      try { iconUrl = (await inspectPackageIcon(request.file.path)).url }
      catch (error) { iconError = error instanceof Error ? error.message : '无法解析图标' }
    }
    response.json({ ...metadata, iconUrl, iconError })
  }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : '读取安装包失败' }) }
  finally { rmSync(request.file.path, { force: true }) }
})

app.post('/api/packages/check-versions', async (request, response) => {
  const parsed = z.object({
    platform: z.enum(['android', 'ios']), packageName: z.string().min(1).max(255),
    versionName: z.string().min(1).max(255), buildNumber: z.string().min(1).max(255),
    stores: z.array(z.enum(credentialProviders)).min(1),
  }).safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ error: '版本校验参数错误' }); return }
  response.json({ checks: await checkPackageVersions(parsed.data, parsed.data.stores) })
})

app.post('/api/releases', upload.single('artifact'), async (request, response) => {
  const parsed = releaseFieldsSchema.safeParse(request.body)
  if (!parsed.success || !request.file) {
    if (request.file) rmSync(request.file.path, { force: true })
    response.status(400).json({ error: parsed.success ? '请选择安装包' : parsed.error.issues[0]?.message })
    return
  }
  const extension = path.extname(request.file.originalname).toLowerCase()
  const allowed = parsed.data.platform === 'android' ? ['.apk', '.aab'] : ['.ipa']
  if (!allowed.includes(extension)) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: `文件格式不正确，需要 ${allowed.join(' 或 ')}` })
    return
  }
  if (parsed.data.stores.length === 0) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: '至少选择一个发布渠道' })
    return
  }
  const notesError = releaseNotesError(parsed.data.releaseNotes, parsed.data.stores)
  if (notesError) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: notesError })
    return
  }
  const selectedApp = db.prepare('SELECT android_package_name, ios_bundle_id FROM apps WHERE id = ?').get(parsed.data.appId) as { android_package_name: string | null; ios_bundle_id: string | null } | undefined
  const hasPlatformIdentifier = parsed.data.platform === 'android' ? selectedApp?.android_package_name : selectedApp?.ios_bundle_id
  if (!selectedApp || !hasPlatformIdentifier) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: '所选应用没有对应平台的包标识' })
    return
  }
  const validStores = parsed.data.platform === 'android' ? new Set<string>(androidStores) : new Set<string>(['apple'])
  if (parsed.data.stores.some((store) => !validStores.has(store))) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: '发布渠道与所选平台不匹配' })
    return
  }
  if (extension === '.aab' && parsed.data.stores.some((store) => store !== 'googleplay')) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: 'AAB 仅支持发布到 Google Play' })
    return
  }
  if (parsed.data.platform === 'android' && ['manual', 'upload_only'].includes(parsed.data.strategy)) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: 'ApkGo Android 发布仅支持审核后发布或商店定时发布' })
    return
  }

  let metadata
  try {
    metadata = await inspectPackage(request.file.path, request.file.originalname)
    verifyPackageIdentity(metadata, selectedApp, parsed.data.platform)
    if (parsed.data.stores.some((store) => requiredIconStores.has(store))) {
      const icon = await inspectPackageIcon(request.file.path)
      for (const store of parsed.data.stores.filter((item) => requiredIconStores.has(item))) await adaptStoreIcon(icon.path, store)
    }
    const checks = await checkPackageVersions(metadata, parsed.data.stores)
    const blocked = checks.filter((item) => item.status === 'blocked')
    if (blocked.length) throw new Error(blocked.map((item) => `${item.store}：${item.message}`).join('；'))
  } catch (error) {
    rmSync(request.file.path, { force: true })
    response.status(400).json({ error: error instanceof Error ? error.message : '安装包版本校验失败' })
    return
  }

  const releaseId = crypto.randomUUID()
  const artifactId = crypto.randomUUID()
  const finalPath = path.join(config.uploadDir, `${artifactId}${extension}`)
  renameSync(request.file.path, finalPath)
  const digest = await sha256(finalPath)
  const now = new Date().toISOString()
  const submitAt = parsed.data.submitAt ? new Date(parsed.data.submitAt).toISOString() : null
  const initialStatus = submitAt && submitAt > now ? 'scheduled' : 'queued'

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO artifacts
        (id, app_id, platform, file_path, original_name, sha256, size, version_name, build_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, parsed.data.appId, parsed.data.platform, finalPath, request.file!.originalname, digest, request.file!.size, metadata.versionName, metadata.buildNumber, now)
    db.prepare(`
      INSERT INTO releases
        (id, app_id, artifact_id, platform, version_name, build_number, strategy, submit_at, store_release_at, timezone, release_notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(releaseId, parsed.data.appId, artifactId, parsed.data.platform, metadata.versionName, metadata.buildNumber, parsed.data.strategy, submitAt, parsed.data.storeReleaseAt ? new Date(parsed.data.storeReleaseAt).toISOString() : null, parsed.data.timezone, parsed.data.releaseNotes, initialStatus, now)
    const insert = db.prepare(`
      INSERT INTO release_targets (id, release_id, store, status, updated_at) VALUES (?, ?, ?, 'queued', ?)
    `)
    for (const store of parsed.data.stores) insert.run(crypto.randomUUID(), releaseId, store, now)
    db.exec('COMMIT')
  } catch (reason) {
    db.exec('ROLLBACK')
    throw reason
  }
  response.status(201).json({ id: releaseId, status: initialStatus, sha256: digest })
})

app.get('/api/releases/:id/events', (request, response) => {
  const details = getReleaseDetails(request.params.id)
  if (!details) { response.status(404).json({ error: '发布任务不存在' }); return }
  response.json(details.events)
})

app.post('/api/releases/:id/targets/:targetId/record-cancellation', (request, response) => {
  const parsed = z.object({ note: z.string().trim().min(1).max(500).optional() }).safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ error: '取消说明格式不正确' }); return }
  try {
    recordStoreCancellation(request.params.id, request.params.targetId, parsed.data.note)
    response.json(getReleaseDetails(request.params.id))
  } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : '无法记录取消状态' }) }
})

app.post('/api/releases/:id/sync', async (request, response) => {
  const release = db.prepare('SELECT app_id FROM releases WHERE id=?').get(request.params.id) as { app_id: string } | undefined
  if (!release) { response.status(404).json({ error: '发布任务不存在' }); return }
  try {
    const result = await syncApp(release.app_id)
    response.json({ ...result, details: getReleaseDetails(request.params.id) })
  } catch { response.status(502).json({ error: '商店状态查询失败，请稍后重试' }) }
})

app.get('/api/releases/:id', (request, response) => {
  const details = getReleaseDetails(request.params.id)
  if (!details) { response.status(404).json({ error: '发布任务不存在' }); return }
  response.json(details)
})

const distDir = path.resolve(process.cwd(), 'dist')
app.use(express.static(distDir))
app.use((_request, response) => response.sendFile(path.join(distDir, 'index.html')))

app.listen(config.port, '127.0.0.1', () => {
  console.log(`ReleasePort API listening on http://127.0.0.1:${config.port}`)
})

startScheduler()
startReviewScheduler()
