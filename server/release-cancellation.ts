import { db } from './db.ts'

const canRecord = new Set(['submitted', 'reviewing', 'approved', 'pending_developer_release'])

// This records a user's confirmed action in the store console. It does not
// call a cancellation API or infer withdrawal from a version mismatch.
export function recordStoreCancellation(releaseId: string, targetId: string, note = '用户确认已在商店后台取消或撤回本次发布') {
  db.exec('BEGIN IMMEDIATE')
  try {
    const target = db.prepare(`SELECT t.id, t.store, t.status, r.app_id, r.version_name, r.build_number, r.status AS release_status
      FROM release_targets t JOIN releases r ON r.id = t.release_id WHERE t.id = ? AND r.id = ?`).get(targetId, releaseId) as {
      id: string; store: string; status: string; app_id: string; version_name: string; build_number: string; release_status: string
    } | undefined
    if (!target) throw new Error('发布渠道记录不存在')
    if (target.status === 'cancelled') { db.exec('COMMIT'); return }
    if (!canRecord.has(target.status) || target.release_status === 'running') throw new Error('仅可记录执行结束后已提交商店的任务取消；此操作不执行商店撤回')
    const now = new Date().toISOString()
    db.prepare("UPDATE release_targets SET status = 'cancelled', status_source = 'user_confirmation', status_note = ?, updated_at = ? WHERE id = ?")
      .run(note, now, target.id)
    const statuses = (db.prepare('SELECT status FROM release_targets WHERE release_id = ?').all(releaseId) as Array<{ status: string }>).map(({ status }) => status)
    const status = statuses.every((value) => value === 'cancelled') ? 'cancelled'
      : statuses.every((value) => ['failed', 'rejected', 'cancelled'].includes(value)) ? 'failed' : 'partial_success'
    // Execution timestamps still describe the original upload; cancellation has
    // its own event timestamp and never rewrites the successful upload history.
    db.prepare('UPDATE releases SET status = ? WHERE id = ?').run(status, releaseId)
    db.prepare('INSERT INTO audit_events (id, release_id, target_id, event_type, safe_payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), releaseId, target.id, 'store_cancellation_recorded', JSON.stringify({ store: target.store, previous_status: target.status, status: 'cancelled', source: 'user_confirmation', note, remote_action: false }), now)
    const latest = db.prepare(`SELECT t.id FROM release_targets t JOIN releases r ON r.id = t.release_id
      WHERE r.app_id = ? AND t.store = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(target.app_id, target.store) as { id: string } | undefined
    if (latest?.id === target.id) {
      db.prepare(`UPDATE app_channels SET review_version = NULL,
        status = CASE WHEN online_version IS NOT NULL THEN 'live' ELSE 'unverified' END, raw_status = ?
        WHERE app_id = ? AND store = ? AND (review_version = ? OR review_version IS NULL)`)
        .run(`版本 ${target.version_name}（${target.build_number}）已取消；来源：用户确认；线上版本保留`, target.app_id, target.store, target.version_name)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
