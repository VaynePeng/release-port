import { jwt } from './release-notes.ts'
import type { ReviewObservation } from './review-status.ts'

export function googleReviewState(raw: string) {
  return ({ RELEASE_LIFECYCLE_STATE_IN_REVIEW: 'reviewing', RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: 'pending_developer_release',
    RELEASE_LIFECYCLE_STATE_NOT_APPROVED: 'rejected', RELEASE_LIFECYCLE_STATE_PUBLISHED: 'live' } as Record<string, string>)[raw] ?? 'unknown'
}
export async function queryGoogleReview(credentials: Record<string, string>, packageName: string, apiFetch: typeof fetch = fetch): Promise<ReviewObservation[]> {
  if (credentials.package_name !== packageName) throw new Error('Google Play 凭证包名与应用不一致')
  const key = JSON.parse(credentials.json_key) as { client_email?: string; private_key?: string }
  if (!key.client_email || !key.private_key) throw new Error('Google Service Account JSON 缺少 client_email 或 private_key')
  const now = Math.floor(Date.now() / 1000)
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300 }, key.private_key, 'RSA-SHA256')
  const auth = await apiFetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(20_000) })
  if (!auth.ok) throw new Error(`Google 鉴权失败（HTTP ${auth.status}）`)
  const token = (await auth.json() as { access_token?: string }).access_token
  if (!token) throw new Error('Google 未返回访问令牌')
  const track = credentials.track || 'production'
  const response = await apiFetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(track)}/releases`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Google Play 审核查询失败（HTTP ${response.status}）`)
  const report = await response.json() as { releases?: Array<{ track: string; releaseLifecycleState: string; activeArtifacts?: Array<{ versionCode: number }> }> }
  if (report.releases !== undefined && !Array.isArray(report.releases)) throw new Error('Google Play 返回无效版本数据')
  return (report.releases ?? []).filter((row) => row.track === track).flatMap((row) => (row.activeArtifacts ?? []).filter((artifact) => Number.isSafeInteger(artifact.versionCode) && artifact.versionCode > 0).map((artifact): ReviewObservation => ({
    store: 'googleplay', source: 'google_play_api', status: googleReviewState(row.releaseLifecycleState), build: String(artifact.versionCode),
    detail: `轨道 ${track} · ${row.releaseLifecycleState}${googleReviewState(row.releaseLifecycleState) === 'rejected' ? '；接口未提供拒绝原因正文，请到 Play Console 查看' : ''}`,
  }))).sort((a, b) => Number(b.build) - Number(a.build))
}
