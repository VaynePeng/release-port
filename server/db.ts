import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(path.join(config.dataDir, 'release-port.db'))

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    android_package_name TEXT,
    ios_bundle_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_channels (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    platform TEXT NOT NULL,
    online_version TEXT,
    review_version TEXT,
    status TEXT NOT NULL,
    raw_status TEXT,
    last_synced_at TEXT,
    UNIQUE(app_id, store)
  );

  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    validation_status TEXT NOT NULL,
    last_validated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    version_name TEXT,
    build_number TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    artifact_id TEXT REFERENCES artifacts(id),
    platform TEXT NOT NULL,
    version_name TEXT NOT NULL,
    build_number TEXT,
    strategy TEXT NOT NULL,
    submit_at TEXT,
    store_release_at TEXT,
    timezone TEXT NOT NULL,
    release_notes TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS release_targets (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    online_version TEXT,
    review_version TEXT,
    error_category TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(release_id, store)
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    release_id TEXT REFERENCES releases(id) ON DELETE CASCADE,
    target_id TEXT REFERENCES release_targets(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    safe_payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`)

const appColumns = db.prepare('PRAGMA table_info(apps)').all() as unknown as Array<{ name: string }>
if (!appColumns.some(({ name }) => name === 'icon_path')) db.exec('ALTER TABLE apps ADD COLUMN icon_path TEXT')

const credentialColumns = db.prepare('PRAGMA table_info(credentials)').all() as unknown as Array<{ name: string }>
if (!credentialColumns.some(({ name }) => name === 'validation_message')) db.exec('ALTER TABLE credentials ADD COLUMN validation_message TEXT')

const targetColumns = db.prepare('PRAGMA table_info(release_targets)').all() as unknown as Array<{ name: string }>
for (const column of ['phase', 'phase_started_at', 'started_at', 'finished_at', 'status_source', 'status_note', 'review_status', 'review_detail', 'review_source', 'review_checked_at', 'review_sync_error', 'external_id']) {
  if (!targetColumns.some(({ name }) => name === column)) db.exec(`ALTER TABLE release_targets ADD COLUMN ${column} TEXT`)
}

export function seedDemoData() {
  if (!config.seedDemo) return
  const existing = db.prepare('SELECT COUNT(*) AS count FROM apps').get() as { count: number }
  if (existing.count > 0) return

  const now = new Date().toISOString()
  const appId = 'app_demo_releaseport'
  db.prepare(`
    INSERT INTO apps (id, name, android_package_name, ios_bundle_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(appId, 'ReleasePort Demo', 'com.releaseport.demo', 'com.releaseport.demo', now, now)

  const channels = [
    ['huawei', 'android', '2.8.1', '2.9.0', 'reviewing'],
    ['xiaomi', 'android', '2.8.1', null, 'live'],
    ['honor', 'android', '2.8.0', '2.9.0', 'reviewing'],
    ['oppo', 'android', '2.8.1', null, 'live'],
    ['vivo', 'android', '2.8.1', null, 'live'],
    ['apple', 'ios', '2.8.1', '2.9.0', 'pending_developer_release'],
  ] as const

  const insertChannel = db.prepare(`
    INSERT INTO app_channels
      (id, app_id, store, platform, online_version, review_version, status, raw_status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const [store, platform, onlineVersion, reviewVersion, status] of channels) {
    insertChannel.run(crypto.randomUUID(), appId, store, platform, onlineVersion, reviewVersion, status, status, now)
  }

  const releaseId = 'release_demo_290'
  db.prepare(`
    INSERT INTO releases
      (id, app_id, platform, version_name, build_number, strategy, timezone, release_notes, status, created_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(releaseId, appId, 'android', '2.9.0', '290', 'automatic', 'Asia/Shanghai', '优化发布流程并修复已知问题', 'reviewing', now, now)

  const insertTarget = db.prepare(`
    INSERT INTO release_targets
      (id, release_id, store, status, progress_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const store of ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo']) {
    insertTarget.run(crypto.randomUUID(), releaseId, store, store === 'honor' || store === 'huawei' ? 'reviewing' : 'submitted', 1, 1, now)
  }
}
