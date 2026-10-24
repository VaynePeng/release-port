import { db } from './db.ts'
import { sanitizeReleaseLog } from './release-logs.ts'

export type ReviewObservation = {
  store: string; status: string; detail: string; source: string
  version?: string; build?: string; submissionId?: string; onlineVersion?: string; error?: string
}
type Target = { id: string; release_id: string; status: string; version_name: string; build_number: string | null; review_status: string | null; review_detail: string | null; external_id: string | null }

export function matchesSubmission(target: { version_name: string; build_number: string | null; external_id?: string | null }, observation: ReviewObservation) {
  if (observation.source === 'honor_api') return Boolean(target.external_id && target.external_id === observation.submissionId)
  if (observation.source === 'google_play_api') return Boolean(target.build_number && target.build_number === observation.build)
  return Boolean(observation.version && observation.version === target.version_name
    && (!target.build_number || observation.build === target.build_number))
}

export function applyReviewObservation(appId: string, observation: ReviewObservation, secrets: string[] = []) {
  const now = new Date().toISOString()
  const detail = sanitizeReleaseLog(observation.detail, secrets)
  const error = observation.error ? sanitizeReleaseLog(observation.error, secrets) : null
  const targets = db.prepare(`SELECT t.*, r.version_name, r.build_number FROM release_targets t JOIN releases r ON r.id = t.release_id
    WHERE r.app_id = ? AND t.store = ? AND r.status NOT IN ('queued','scheduled','running')
    AND t.status IN ('submitted','reviewing','approved','pending_developer_release','rejected','live','withdrawn')
    ORDER BY r.created_at DESC, r.rowid DESC`).all(appId, observation.store) as Target[]
  // Store APIs usually expose only the latest submission. Never attach its result
  // to an older retry of the same version/build, or to a user-cancelled task.
  const latest = db.prepare(`SELECT t.id FROM release_targets t JOIN releases r ON r.id=t.release_id
    WHERE r.app_id=? AND t.store=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(appId, observation.store) as { id: string } | undefined
  const target = targets.find((row) => row.id === latest?.id)
  if (!target) return
  const matched = matchesSubmission(target, observation)
  const confirmed = !error && matched && ['reviewing','approved','rejected','withdrawn','live','pending_developer_release'].includes(observation.status)
  const note = error ? target.review_detail || detail : matched ? detail : target.review_detail || `${detail}；返回版本/构建号不足以匹配本次任务，保留提交状态`
  db.prepare(`UPDATE release_targets SET review_status=?, review_detail=?, review_source=?, review_checked_at=?, review_sync_error=? WHERE id=?`)
    .run(confirmed ? observation.status : target.review_status, note, observation.source, now, error, target.id)
  if (!confirmed) return
  db.prepare("UPDATE release_targets SET status=?,status_source='store_api',updated_at=? WHERE id=?").run(observation.status, now, target.id)
  if (target.review_status !== observation.status || target.review_detail !== note) {
    db.prepare('INSERT INTO audit_events (id,release_id,target_id,event_type,safe_payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), target.release_id, target.id, 'store_review_synced', JSON.stringify({ store: observation.store, status: observation.status, detail, source: observation.source, version: observation.version, build: observation.build }), now)
  }
  const statuses = (db.prepare('SELECT status FROM release_targets WHERE release_id=?').all(target.release_id) as Array<{ status: string }>).map((row) => row.status)
  const aggregate = statuses.every((s) => s === 'live') ? 'live'
    : statuses.every((s) => s === 'rejected') ? 'rejected'
      : statuses.every((s) => s === 'withdrawn') ? 'withdrawn'
        : statuses.some((s) => ['failed','rejected','withdrawn','cancelled'].includes(s)) ? 'partial_success'
          : statuses.some((s) => s === 'reviewing') ? 'reviewing'
            : statuses.every((s) => ['approved','live'].includes(s)) ? 'approved'
              : statuses.some((s) => s === 'pending_developer_release') ? 'pending_developer_release' : 'submitted'
  db.prepare('UPDATE releases SET status=? WHERE id=?').run(aggregate, target.release_id)
}
