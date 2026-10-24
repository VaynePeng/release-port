import { db } from './db.ts'
import { decryptSecret } from './vault.ts'
import { sanitizeReleaseLog } from './release-logs.ts'

type CountRow = { count: number }

export function getReleaseDetails(id: string) {
  const release = db.prepare(`SELECT r.*, a.name AS app_name,
    artifact.original_name AS artifact_name, artifact.size AS artifact_size, artifact.sha256 AS artifact_sha256
    FROM releases r JOIN apps a ON a.id = r.app_id
    LEFT JOIN artifacts artifact ON artifact.id = r.artifact_id WHERE r.id = ?`).get(id)
  if (!release) return null
  const secrets: string[] = []
  for (const row of db.prepare('SELECT encrypted_payload FROM credentials').all() as Array<{ encrypted_payload: string }>) {
    try { secrets.push(...Object.values(decryptSecret(row.encrypted_payload))) } catch { /* Other credentials may be unavailable. */ }
  }
  const targets = db.prepare('SELECT * FROM release_targets WHERE release_id = ? ORDER BY store').all(id)
    .map((row) => ({ ...row, error_message: typeof row.error_message === 'string' ? sanitizeReleaseLog(row.error_message, secrets) : null }))
  const events = db.prepare('SELECT id, target_id, event_type, safe_payload_json, created_at FROM audit_events WHERE release_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 300').all(id)
    .map((row) => ({ id: row.id, target_id: row.target_id, event_type: row.event_type,
      message: sanitizeReleaseLog(String(row.safe_payload_json), secrets), created_at: row.created_at }))
  return { release, targets, events }
}

export function getBootstrapData() {
  const apps = db.prepare(`
    SELECT a.id, a.name, a.android_package_name, a.ios_bundle_id, a.created_at, a.updated_at,
      CASE WHEN a.icon_path IS NOT NULL THEN '/api/apps/' || a.id || '/icon?v=' || strftime('%s', a.updated_at) END AS icon_url,
      (SELECT COUNT(*) FROM app_channels c WHERE c.app_id = a.id AND c.status IN ('reviewing', 'submitted', 'pending_developer_release')) AS active_channels,
      (SELECT COUNT(*) FROM app_channels c WHERE c.app_id = a.id AND c.status IN ('failed', 'rejected')) AS issue_channels
    FROM apps a ORDER BY a.updated_at DESC
  `).all()

  const channels = db.prepare('SELECT * FROM app_channels ORDER BY platform, store').all()
  const releases = db.prepare(`
    SELECT r.*, a.name AS app_name,
      (SELECT COUNT(*) FROM release_targets t WHERE t.release_id = r.id) AS target_count,
      (SELECT COUNT(*) FROM release_targets t WHERE t.release_id = r.id AND t.status IN ('failed', 'rejected')) AS failed_count
    FROM releases r JOIN apps a ON a.id = r.app_id
    ORDER BY r.created_at DESC LIMIT 50
  `).all()
  const targets = db.prepare('SELECT * FROM release_targets ORDER BY updated_at DESC').all()
  const credentials = db.prepare(`
    SELECT id, provider, label, fingerprint, validation_status, validation_message, last_validated_at, created_at, updated_at
    FROM credentials ORDER BY provider
  `).all()
  const activeReleases = db.prepare(`
    SELECT COUNT(*) AS count FROM releases WHERE status IN ('scheduled', 'queued', 'running', 'submitted', 'reviewing')
  `).get() as CountRow
  const publishedReleases = db.prepare(`
    SELECT COUNT(*) AS count FROM releases WHERE status = 'live'
  `).get() as CountRow

  return {
    apps,
    channels,
    releases,
    targets,
    credentials,
    summary: {
      apps: apps.length,
      activeReleases: activeReleases.count,
      publishedReleases: publishedReleases.count,
      configuredCredentials: credentials.length,
    },
  }
}
