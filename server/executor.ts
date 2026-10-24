import { submissionIdsFromDone } from './honor-review.ts'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db } from './db.ts'
import { getToolStatus } from './tools.ts'
import { decryptSecret } from './vault.ts'
import { prepareAppleReleaseNotes, releaseNotesError, updateSamsungReleaseNotes } from './release-notes.ts'
import { inspectPackage, verifyPackageIdentity } from './package-metadata.ts'
import { checkPackageVersions } from './version-check.ts'
import { inspectPackageIcon, adaptStoreIcon } from './package-icon.ts'
import { requiredIconStores } from '../src/lib/store-icons.ts'
import { uploadFirIcon } from './fir-icon.ts'
import { sanitizeReleaseLog, classifyReleaseError } from './release-logs.ts'

type ReleaseRow = {
  id: string
  platform: 'android' | 'ios'
  artifact_id: string
  file_path: string
  strategy: string
  store_release_at: string | null
  release_notes: string
  version_name: string
  ios_bundle_id: string | null
  android_package_name: string | null
  build_number: string
}

type TargetRow = { id: string; store: string }

function updateRelease(id: string, status: string, finished = false) {
  db.prepare(`
    UPDATE releases SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?
  `).run(status, new Date().toISOString(), finished ? new Date().toISOString() : null, id)
}

function updateTarget(targetId: string, status: string, extra: { sent?: number; total?: number; category?: string; error?: string } = {}) {
  const previous = db.prepare('SELECT release_id, store, status, phase FROM release_targets WHERE id = ?').get(targetId) as { release_id: string; store: string; status: string; phase: string | null } | undefined
  if (!previous) return
  if (extra.error) extra.error = sanitizeReleaseLog(extra.error, Object.values(getCredentialPayload(previous.store) ?? {}))
  const now = new Date().toISOString()
  const terminal = ['failed', 'submitted', 'uploaded', 'rejected', 'live'].includes(status)
  const phase = terminal ? previous.phase : status
  db.prepare(`
    UPDATE release_targets SET status = ?, progress_bytes = COALESCE(?, progress_bytes),
      total_bytes = COALESCE(?, total_bytes), error_category = ?, error_message = ?, updated_at = ?,
      phase = ?, phase_started_at = CASE WHEN phase IS NOT ? THEN ? ELSE phase_started_at END,
      started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `).run(status, extra.sent ?? null, extra.total ?? null, extra.error ? classifyReleaseError(extra.error, extra.category) : extra.category ?? null,
    extra.error ?? null, now, phase, phase, now, now, terminal ? now : null, targetId)
  if (previous.status !== status || extra.error) addEvent(previous.release_id, 'target_status', {
    store: previous.store, status, phase, error: extra.error, category: extra.error ? classifyReleaseError(extra.error, extra.category) : extra.category,
  }, targetId)
}

function addEvent(releaseId: string, eventType: string, payload: unknown, targetId: string | null = null) {
  db.prepare(`
    INSERT INTO audit_events (id, release_id, target_id, event_type, safe_payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), releaseId, targetId, eventType, JSON.stringify(payload), new Date().toISOString())
}

function getRelease(releaseId: string) {
  return db.prepare(`
    SELECT r.*, a.file_path, app.ios_bundle_id, app.android_package_name FROM releases r
    JOIN artifacts a ON a.id = r.artifact_id
    JOIN apps app ON app.id = r.app_id
    WHERE r.id = ?
  `).get(releaseId) as ReleaseRow | undefined
}

function getTargets(releaseId: string) {
  return db.prepare('SELECT id, store FROM release_targets WHERE release_id = ?').all(releaseId) as unknown as TargetRow[]
}

function getCredentialPayload(provider: string) {
  const row = db.prepare('SELECT encrypted_payload FROM credentials WHERE provider = ?').get(provider) as { encrypted_payload: string } | undefined
  return row ? decryptSecret(row.encrypted_payload) : null
}

function finishFromTargets(releaseId: string) {
  const states = db.prepare('SELECT status FROM release_targets WHERE release_id = ?').all(releaseId) as unknown as Array<{ status: string }>
  const success = states.filter(({ status }) => ['submitted', 'reviewing', 'approved', 'live'].includes(status)).length
  const failed = states.filter(({ status }) => ['failed', 'rejected'].includes(status)).length
  if (failed === states.length) updateRelease(releaseId, 'failed', true)
  else if (failed > 0 && success > 0) updateRelease(releaseId, 'partial_success', true)
  else if (states.every(({ status }) => status === 'uploaded')) updateRelease(releaseId, 'uploaded', true)
  else if (states.every(({ status }) => ['submitted', 'reviewing', 'approved', 'live', 'uploaded'].includes(status))) updateRelease(releaseId, 'submitted', true)
  else updateRelease(releaseId, 'failed', true)
}

async function executeAndroid(release: ReleaseRow, targets: TargetRow[]) {
  const apkgo = getToolStatus().find(({ name }) => name === 'apkgo')
  if (!apkgo?.installed) {
    for (const target of targets) updateTarget(target.id, 'failed', { category: 'missing_tool', error: '本机尚未安装 apkgo' })
    updateRelease(release.id, 'failed', true)
    return
  }

  const stores: Record<string, Record<string, string>> = {}
  const tempDir = path.join(config.dataDir, 'tmp', release.id)
  for (const target of targets) {
    const payload = getCredentialPayload(target.store)
    if (!payload) {
      updateTarget(target.id, 'failed', { category: 'auth_failed', error: '尚未配置该渠道凭证' })
      continue
    }
    try {
      const normalized = Object.fromEntries(Object.entries(payload).filter(([, value]) => value.trim() !== ''))
      if (target.store === 'huawei' && normalized.service_account_json) {
        JSON.parse(normalized.service_account_json)
        normalized.service_account = Buffer.from(normalized.service_account_json).toString('base64')
        delete normalized.service_account_json
      }
      if (target.store === 'googleplay' && normalized.json_key) {
        JSON.parse(normalized.json_key)
        mkdirSync(tempDir, { recursive: true, mode: 0o700 })
        const keyPath = path.join(tempDir, 'google-play-service-account.json')
        writeFileSync(keyPath, normalized.json_key, { mode: 0o600 })
        normalized.json_key_file = keyPath
        delete normalized.json_key
      }
      if (target.store === 'samsung') {
        updateTarget(target.id, 'validating')
        try {
          await updateSamsungReleaseNotes(normalized, release.release_notes, release.strategy === 'scheduled_release' ? release.store_release_at : null)
          addEvent(release.id, 'release_notes_updated', { store: 'samsung', field: 'newFeature', verified: true }, target.id)
        } catch (error) {
          updateTarget(target.id, 'failed', { category: 'release_notes_failed', error: error instanceof Error ? error.message : '三星更新说明上传失败' })
          continue
        }
      }
      stores[target.store] = normalized
    } catch {
      updateTarget(target.id, 'failed', { category: 'config_invalid', error: '凭证中的 JSON 内容格式不正确' })
    }
  }

  let listingPath: string | undefined
  const listingStores: Record<string, { icon: string }> = {}
  const iconTargets = targets.filter(({ store }) => requiredIconStores.has(store) && stores[store])
  const packageIcon = iconTargets.length ? inspectPackageIcon(release.file_path) : null
  for (const target of iconTargets) {
    updateTarget(target.id, 'icon')
    try {
      const icon = (await packageIcon)!
      const storeIconPath = await adaptStoreIcon(icon.path, target.store)
      const size = target.store === 'huawei' ? 216 : 512
      addEvent(release.id, 'package_icon_prepared', { store: target.store, source: 'apk_manifest', kind: icon.kind, width: size, height: size, preview: icon.url }, target.id)
      if (target.store === 'fir') {
        updateTarget(target.id, 'icon_uploading')
        await uploadFirIcon(release.android_package_name!, stores.fir.api_token, storeIconPath)
        addEvent(release.id, 'package_icon_uploaded', { store: 'fir', confirmed: true }, target.id)
      } else listingStores[target.store] = { icon: storeIconPath }
    } catch (error) {
      delete stores[target.store]
      updateTarget(target.id, 'failed', { category: 'icon_invalid', error: error instanceof Error ? error.message : '安装包图标准备失败' })
    }
  }
  if (Object.keys(listingStores).length) {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    listingPath = path.join(tempDir, 'listing.json')
    writeFileSync(listingPath, JSON.stringify({ stores: listingStores }), { mode: 0o600 })
  }
  const runnable = targets.filter(({ store }) => stores[store])
  if (runnable.length === 0) {
    rmSync(tempDir, { recursive: true, force: true })
    updateRelease(release.id, 'failed', true)
    return
  }

  const args = [
    'upload', '-f', release.file_path,
    '-s', runnable.map(({ store }) => store).join(','),
    '--notes', release.release_notes,
    '--progress-stream',
    '--creds-from=stdin',
  ]
  if (release.strategy === 'scheduled_release' && release.store_release_at) {
    args.push('--release-time', release.store_release_at)
  }
  if (listingPath) args.push('--listing', listingPath)

  updateRelease(release.id, 'running')
  for (const target of runnable) updateTarget(target.id, 'validating')
  addEvent(release.id, 'execution_started', { engine: 'apkgo', stores: runnable.map(({ store }) => store) })

  await new Promise<void>((resolve) => {
    const child = spawn('apkgo', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    const secrets = Object.values(stores).flatMap((fields) => Object.values(fields))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ stores }))

    const completed = new Set<string>()
    function consume(line: string) {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        for (const submission of submissionIdsFromDone(event)) {
          const item = runnable.find((row) => row.store === submission.store)
          if (item) db.prepare('UPDATE release_targets SET external_id=? WHERE id=?').run(submission.id, item.id)
        }
        const store = typeof event.store === 'string' ? event.store : null
        const target = store ? runnable.find((item) => item.store === store) : null
        if (event.type === 'phase' && target && typeof event.phase === 'string') updateTarget(target.id, event.phase)
        if (event.type === 'total' && target && Number.isFinite(event.total_bytes) && Number(event.total_bytes) >= 0) updateTarget(target.id, 'uploading', { sent: 0, total: Number(event.total_bytes) })
        if (event.type === 'bytes' && target && Number.isFinite(event.sent) && Number(event.sent) >= 0) updateTarget(target.id, 'uploading', { sent: Number(event.sent), total: Number.isFinite(event.total) && Number(event.total) >= 0 ? Number(event.total) : undefined })
        if (event.type === 'result' && target) {
          completed.add(target.id)
          const error = typeof event.error === 'string' ? sanitizeReleaseLog(event.error, secrets) : undefined
          updateTarget(target.id, event.success === true ? 'submitted' : 'failed', {
            category: typeof event.category === 'string' ? event.category : undefined, error,
          })
          addEvent(release.id, 'target_result', { store, success: event.success === true, duration_ms: event.duration_ms, error }, target.id)
        }
      } catch {
        addEvent(release.id, 'tool_log', { engine: 'apkgo', message: sanitizeReleaseLog(line, secrets) })
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    child.on('error', (error) => {
      for (const target of runnable) updateTarget(target.id, 'failed', { category: 'unknown', error: error.message })
    })
    child.on('close', (code) => {
      consume(buffer)
      for (const target of runnable) {
        if (!completed.has(target.id)) updateTarget(target.id, 'failed', {
          category: 'incomplete_result', error: sanitizeReleaseLog(stderr || `ApkGo 已退出（退出码 ${code}），但未返回该渠道的最终结果`, secrets),
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
      addEvent(release.id, 'execution_finished', { engine: 'apkgo', exitCode: code, stderr: sanitizeReleaseLog(stderr, secrets) })
      finishFromTargets(release.id)
      resolve()
    })
  })
}

async function executeIos(release: ReleaseRow, targets: TargetRow[]) {
  const target = targets[0]
  const fastlane = getToolStatus().find(({ name }) => name === 'fastlane')
  const apple = getCredentialPayload('apple')
  if (!target) return
  if (!fastlane?.installed || !apple) {
    updateTarget(target.id, 'failed', {
      category: fastlane?.installed ? 'auth_failed' : 'missing_tool',
      error: fastlane?.installed ? '尚未配置 Apple API Key' : '本机尚未安装 fastlane',
    })
    updateRelease(release.id, 'failed', true)
    return
  }

  const tempDir = path.join(config.dataDir, 'tmp', release.id)
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  const apiKeyPath = path.join(tempDir, 'app-store-connect-key.json')
  writeFileSync(apiKeyPath, JSON.stringify({
    key_id: apple.key_id,
    issuer_id: apple.issuer_id,
    key: apple.private_key,
    in_house: apple.in_house === 'true',
  }), { mode: 0o600 })

  const metadataPath = path.join(tempDir, 'metadata')
  try {
    if (!release.ios_bundle_id) throw new Error('缺少 iOS Bundle ID，无法确认更新说明所属应用')
    const locale = await prepareAppleReleaseNotes(apple, release.ios_bundle_id, release.release_notes, metadataPath)
    addEvent(release.id, 'release_notes_prepared', { store: 'apple', locale }, target.id)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    updateTarget(target.id, 'failed', { category: 'release_notes_failed', error: error instanceof Error ? error.message : '准备 Apple 更新说明失败' })
    updateRelease(release.id, 'failed', true)
    return
  }
  const args = ['deliver', '--ipa', release.file_path, '--api_key_path', apiKeyPath,
    '--app_identifier', release.ios_bundle_id, '--app_version', release.version_name,
    '--metadata_path', metadataPath, '--force', '--skip_metadata', 'false', '--skip_screenshots']
  if (release.strategy !== 'upload_only') args.push('--submit_for_review')
  if (release.strategy === 'automatic') args.push('--automatic_release', 'true')
  if (release.strategy === 'manual') args.push('--automatic_release', 'false')
  if (release.strategy === 'scheduled_release' && release.store_release_at) args.push('--auto_release_date', String(new Date(release.store_release_at).getTime()))

  updateRelease(release.id, 'running')
  updateTarget(target.id, 'uploading')
  addEvent(release.id, 'execution_started', { engine: 'fastlane', store: 'apple' })

  await new Promise<void>((resolve) => {
    const child = spawn('fastlane', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let output = ''
    const secrets = Object.values(apple)
    function consumeApple(line: string) {
      const message = sanitizeReleaseLog(line, secrets)
      if (!message.trim()) return
      addEvent(release.id, 'tool_log', { engine: 'fastlane', message }, target.id)
      if (/Submitting.*(?:review|app)|submit.*for review/i.test(message)) updateTarget(target.id, 'submitting')
      else if (/Uploading.*metadata|Uploading.*release notes/i.test(message)) updateTarget(target.id, 'metadata')
      else if (/Uploading.*(?:binary|ipa)|Transporter.*upload/i.test(message)) updateTarget(target.id, 'uploading')
      else if (/Waiting.*processing|Processing.*build/i.test(message)) updateTarget(target.id, 'processing')
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      const lines = output.split('\n')
      output = lines.pop() ?? ''
      for (const line of lines) consumeApple(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    child.on('error', (error) => updateTarget(target.id, 'failed', { category: 'unknown', error: error.message }))
    child.on('close', (code) => {
      consumeApple(output)
      rmSync(tempDir, { recursive: true, force: true })
      if (code === 0) updateTarget(target.id, release.strategy === 'upload_only' ? 'uploaded' : 'submitted')
      else updateTarget(target.id, 'failed', { category: 'unknown', error: sanitizeReleaseLog(stderr || `fastlane 退出码 ${code}`, secrets) })
      addEvent(release.id, 'execution_finished', { engine: 'fastlane', exitCode: code, stderr: sanitizeReleaseLog(stderr, secrets) })
      finishFromTargets(release.id)
      resolve()
    })
  })
}

const running = new Set<string>()

export async function executeRelease(releaseId: string) {
  if (running.has(releaseId)) return
  const release = getRelease(releaseId)
  if (!release) return
  const targets = getTargets(releaseId)
  const notesError = releaseNotesError(release.release_notes, targets.map(({ store }) => store))
  if (notesError) {
    for (const target of targets) updateTarget(target.id, 'failed', { category: 'release_notes_invalid', error: notesError })
    updateRelease(releaseId, 'failed', true)
    return
  }
  running.add(releaseId)
  try {
    updateRelease(releaseId, 'running')
    for (const target of targets) updateTarget(target.id, 'validating')
    try {
      const metadata = await inspectPackage(release.file_path, release.file_path)
      verifyPackageIdentity(metadata, release, release.platform)
      if (metadata.versionName !== release.version_name || metadata.buildNumber !== release.build_number) throw new Error('安装包版本信息与任务记录不一致，请重新创建发布')
      const checks = await checkPackageVersions(metadata, targets.map(({ store }) => store))
      const blocked = checks.filter((item) => item.status === 'blocked')
      if (blocked.length) throw new Error(blocked.map((item) => `${item.store}：${item.message}`).join('；'))
    } catch (error) {
      for (const target of targets) updateTarget(target.id, 'failed', { category: 'version_check_failed', error: error instanceof Error ? error.message : '发布前版本校验失败' })
      updateRelease(releaseId, 'failed', true)
      return
    }
    if (release.platform === 'android') await executeAndroid(release, targets)
    else await executeIos(release, targets)
  } finally {
    running.delete(releaseId)
  }
}

export function startScheduler() {
  const tick = () => {
    const due = db.prepare(`
      SELECT id FROM releases
      WHERE status IN ('queued', 'scheduled') AND (submit_at IS NULL OR submit_at <= ?)
      ORDER BY created_at LIMIT 3
    `).all(new Date().toISOString()) as unknown as Array<{ id: string }>
    for (const release of due) void executeRelease(release.id)
  }
  tick()
  return setInterval(tick, 15_000)
}
