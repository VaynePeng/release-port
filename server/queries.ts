import { db } from './db.ts'

type CountRow = { count: number }

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
    SELECT id, provider, label, fingerprint, validation_status, last_validated_at, created_at, updated_at
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
