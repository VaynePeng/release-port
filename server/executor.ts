import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db } from './db.ts'
import { getToolStatus } from './tools.ts'
import { decryptSecret } from './vault.ts'

type ReleaseRow = {
  id: string
  platform: 'android' | 'ios'
  artifact_id: string
  file_path: string
  strategy: string
  store_release_at: string | null
  release_notes: string
}

type TargetRow = { id: string; store: string }

function updateRelease(id: string, status: string, finished = false) {
  db.prepare(`
    UPDATE releases SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?
  `).run(status, new Date().toISOString(), finished ? new Date().toISOString() : null, id)
}

function updateTarget(targetId: string, status: string, extra: { sent?: number; total?: number; category?: string; error?: string } = {}) {
  db.prepare(`
    UPDATE release_targets SET status = ?, progress_bytes = COALESCE(?, progress_bytes),
      total_bytes = COALESCE(?, total_bytes), error_category = ?, error_message = ?, updated_at = ?
    WHERE id = ?
  `).run(status, extra.sent ?? null, extra.total ?? null, extra.category ?? null, extra.error ?? null, new Date().toISOString(), targetId)
}

function addEvent(releaseId: string, eventType: string, payload: unknown, targetId: string | null = null) {
  db.prepare(`
    INSERT INTO audit_events (id, release_id, target_id, event_type, safe_payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), releaseId, targetId, eventType, JSON.stringify(payload), new Date().toISOString())
}

function getRelease(releaseId: string) {
  return db.prepare(`
    SELECT r.*, a.file_path FROM releases r
    JOIN artifacts a ON a.id = r.artifact_id
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
  else updateRelease(releaseId, 'submitted', true)
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
      stores[target.store] = normalized
    } catch {
      updateTarget(target.id, 'failed', { category: 'config_invalid', error: '凭证中的 JSON 内容格式不正确' })
    }
  }

  const runnable = targets.filter(({ store }) => stores[store])
  if (runnable.length === 0) {
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

  updateRelease(release.id, 'running')
  for (const target of runnable) updateTarget(target.id, 'validating')
  addEvent(release.id, 'execution_started', { engine: 'apkgo', stores: runnable.map(({ store }) => store) })

  await new Promise<void>((resolve) => {
    const child = spawn('apkgo', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    child.stdin.end(JSON.stringify({ stores }))

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          const store = typeof event.store === 'string' ? event.store : null
          const target = store ? runnable.find((item) => item.store === store) : null
          if (event.type === 'phase' && target) updateTarget(target.id, String(event.phase ?? 'running'))
          if (event.type === 'total' && target) updateTarget(target.id, 'uploading', { total: Number(event.total_bytes ?? 0) })
          if (event.type === 'bytes' && target) updateTarget(target.id, 'uploading', { sent: Number(event.sent ?? 0), total: Number(event.total ?? 0) })
          if (event.type === 'result' && target) {
            const ok = event.success === true
            updateTarget(target.id, ok ? 'submitted' : 'failed', {
              category: typeof event.category === 'string' ? event.category : undefined,
              error: typeof event.error === 'string' ? event.error : undefined,
            })
          }
        } catch {
          addEvent(release.id, 'unparsed_output', { line: line.slice(0, 500) })
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.on('error', (error) => {
      for (const target of runnable) updateTarget(target.id, 'failed', { category: 'unknown', error: error.message })
    })
    child.on('close', (code) => {
      rmSync(tempDir, { recursive: true, force: true })
      addEvent(release.id, 'execution_finished', { engine: 'apkgo', exitCode: code, stderr: stderr.replace(/(secret|token|key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]') })
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

  const args = ['deliver', '--ipa', release.file_path, '--api_key_path', apiKeyPath, '--force', '--skip_metadata', '--skip_screenshots']
  if (release.strategy !== 'upload_only') args.push('--submit_for_review')
  if (release.strategy === 'automatic') args.push('--automatic_release', 'true')
  if (release.strategy === 'manual') args.push('--automatic_release', 'false')
  if (release.strategy === 'scheduled_release' && release.store_release_at) args.push('--auto_release_date', String(new Date(release.store_release_at).getTime()))

  updateRelease(release.id, 'running')
  updateTarget(target.id, 'uploading')
  addEvent(release.id, 'execution_started', { engine: 'fastlane', store: 'apple' })

  await new Promise<void>((resolve) => {
    const child = spawn('fastlane', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.on('error', (error) => updateTarget(target.id, 'failed', { category: 'unknown', error: error.message }))
    child.on('close', (code) => {
      rmSync(tempDir, { recursive: true, force: true })
      if (code === 0) updateTarget(target.id, release.strategy === 'upload_only' ? 'uploaded' : 'submitted')
      else updateTarget(target.id, 'failed', { category: 'unknown', error: stderr || `fastlane 退出码 ${code}` })
      addEvent(release.id, 'execution_finished', { engine: 'fastlane', exitCode: code })
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
  running.add(releaseId)
  try {
    const targets = getTargets(releaseId)
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
