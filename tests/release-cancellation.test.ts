import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('recording a store cancellation preserves upload history, scopes the change and never treats it as an API result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-cancel-'))
  process.env.RELEASE_PORT_DATA_DIR = root
  const { db } = await import('../server/db.ts')
  const { recordStoreCancellation } = await import('../server/release-cancellation.ts')
  const { getBootstrapData, getReleaseDetails } = await import('../server/queries.ts')
  const now = '2026-10-24T01:00:00.000Z'
  db.prepare('INSERT INTO apps (id,name,android_package_name,created_at,updated_at) VALUES (?,?,?,?,?)').run('app', 'Test', 'com.example.test', now, now)
  function release(id: string, stores: string[], status = 'submitted', version = '1.4.2', created = now) {
    db.prepare(`INSERT INTO releases (id,app_id,platform,version_name,build_number,strategy,timezone,release_notes,status,created_at,started_at,finished_at)
      VALUES (?,'app','android',?,'66','automatic','Asia/Shanghai','notes',?,?,?,?)`).run(id, version, status, created, now, now)
    for (const store of stores) db.prepare(`INSERT INTO release_targets (id,release_id,store,status,progress_bytes,total_bytes,phase,started_at,finished_at,updated_at)
      VALUES (?,?,?,'submitted',100,100,'uploading',?,?,?)`).run(`${id}-${store}`, id, store, now, now, now)
  }
  try {
    release('cancel', ['xiaomi'])
    db.prepare(`INSERT INTO app_channels (id,app_id,store,platform,online_version,review_version,status,last_synced_at)
      VALUES ('channel','app','xiaomi','android','1.4.1','1.4.2','reviewing',?)`).run(now)
    recordStoreCancellation('cancel', 'cancel-xiaomi')
    const detail = getReleaseDetails('cancel')!
    assert.equal(detail.release.status, 'cancelled')
    assert.equal(detail.release.finished_at, now)
    assert.equal(detail.targets[0].status, 'cancelled')
    assert.equal(detail.targets[0].status_source, 'user_confirmation')
    assert.equal(detail.targets[0].progress_bytes, 100)
    assert.equal(detail.targets[0].phase, 'uploading')
    assert.equal(detail.targets[0].finished_at, now)
    const payload = JSON.parse(detail.events[0].message)
    assert.equal(payload.remote_action, false)
    assert.equal(payload.source, 'user_confirmation')
    recordStoreCancellation('cancel', 'cancel-xiaomi')
    assert.equal(getReleaseDetails('cancel')!.events.length, 1)
    const channel = db.prepare("SELECT * FROM app_channels WHERE id = 'channel'").get()!
    assert.equal(channel.online_version, '1.4.1')
    assert.equal(channel.review_version, null)
    assert.equal(channel.status, 'live')
    assert.equal(channel.last_synced_at, now)
    assert.equal(getBootstrapData().summary.activeReleases, 0)

    release('mixed', ['xiaomi', 'oppo'])
    recordStoreCancellation('mixed', 'mixed-xiaomi')
    assert.equal(getReleaseDetails('mixed')!.release.status, 'partial_success')
    assert.equal(db.prepare("SELECT status FROM release_targets WHERE id = 'mixed-oppo'").get()?.status, 'submitted')
    recordStoreCancellation('mixed', 'mixed-oppo')
    assert.equal(getReleaseDetails('mixed')!.release.status, 'cancelled')

    release('running', ['xiaomi'], 'running')
    assert.throws(() => recordStoreCancellation('running', 'running-xiaomi'), /执行结束/)
    assert.equal(getReleaseDetails('running')!.events.length, 0)
    assert.throws(() => recordStoreCancellation('cancel', 'running-xiaomi'), /不存在/)

    release('old', ['xiaomi'])
    release('new', ['xiaomi'], 'submitted', '1.4.3', '2026-10-24T02:00:00.000Z')
    db.prepare("UPDATE app_channels SET review_version = '1.4.3', status = 'reviewing' WHERE id = 'channel'").run()
    recordStoreCancellation('old', 'old-xiaomi')
    assert.equal(db.prepare("SELECT review_version FROM app_channels WHERE id = 'channel'").get()?.review_version, '1.4.3')
    assert.equal(db.prepare("SELECT status FROM release_targets WHERE id = 'new-xiaomi'").get()?.status, 'submitted')
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
