import assert from 'node:assert/strict'
import { test } from 'node:test'
import { targetProgress } from '../src/lib/release-progress.ts'
import { classifyReleaseError, sanitizeReleaseLog } from '../server/release-logs.ts'
import type { ReleaseTarget } from '../src/types.ts'

const target: ReleaseTarget = { id: 'test', release_id: 'test', store: 'xiaomi', status: 'failed', phase: null, phase_started_at: null, started_at: null, finished_at: null, progress_bytes: 0, total_bytes: 0, error_category: null, error_message: 'query: [-20035] 请求频率太快', updated_at: new Date().toISOString() }

test('historical failures show evidence without inventing upload percentages', () => {
  const progress = targetProgress(target)
  assert.equal(progress.phaseLabel, '查询商店版本')
  assert.ok(progress.inferred)
  assert.equal(progress.percent, null)
  assert.match(progress.text, /尚未进入上传/)
  assert.equal(classifyReleaseError(target.error_message!), 'rate_limited')
})

test('byte progress is distinct from publishing and terminal state', () => {
  const uploading = targetProgress({ ...target, status: 'uploading', phase: 'uploading', progress_bytes: 512, total_bytes: 1024 })
  assert.equal(uploading.percent, 50)
  const publishing = targetProgress({ ...target, status: 'publishing', phase: 'publishing', progress_bytes: 1024, total_bytes: 1024 })
  assert.equal(publishing.percent, 100)
  assert.equal(publishing.phaseLabel, '提交发布')
  assert.equal(targetProgress({ ...target, store: 'apple', error_message: null }).percent, null)
})

test('tool logs retain diagnostics while hiding saved secrets and bearer tokens', () => {
  const safe = sanitizeReleaseLog('query: [-20035] 请求频率太快 email=owner@test.invalid Authorization: Bearer abc.def password=top-secret', ['owner@test.invalid'])
  assert.match(safe, /-20035/)
  for (const value of ['owner@test.invalid', 'abc.def', 'top-secret']) assert.ok(!safe.includes(value))
})
