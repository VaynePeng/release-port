import { jwt } from './release-notes.ts'
import type { ReviewObservation } from './review-status.ts'

export function appleReviewState(raw: string): string {
  if (['WAITING_FOR_REVIEW','IN_REVIEW','WAITING_FOR_EXPORT_COMPLIANCE'].includes(raw)) return 'reviewing'
  if (['REJECTED','METADATA_REJECTED','INVALID_BINARY'].includes(raw)) return 'rejected'
  if (raw === 'DEVELOPER_REJECTED') return 'withdrawn'
  if (raw === 'PENDING_DEVELOPER_RELEASE') return 'pending_developer_release'
  if (['READY_FOR_SALE','READY_FOR_DISTRIBUTION'].includes(raw)) return 'live'
  if (raw === 'PENDING_APPLE_RELEASE') return 'approved'
  return 'unknown'
}
type Resource = { id: string; type: string; attributes: Record<string, string>; relationships?: { build?: { data?: { id: string } | null } } }
export async function queryAppleReview(credentials: Record<string, string>, bundleId: string, apiFetch: typeof fetch = fetch): Promise<ReviewObservation[]> {
  const now = Math.floor(Date.now() / 1000)
  const token = jwt({ alg: 'ES256', kid: credentials.key_id, typ: 'JWT' }, { iss: credentials.issuer_id, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' }, credentials.private_key, 'sha256')
  async function read(url: string): Promise<{ data: Resource[]; included?: Resource[]; links?: { next?: string } }> {
    if (new URL(url).origin !== 'https://api.appstoreconnect.apple.com') throw new Error('Apple 返回无效分页地址')
    const response = await apiFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!response.ok) throw new Error(`App Store Connect 查询失败（HTTP ${response.status}）`)
    const report = await response.json() as Awaited<ReturnType<typeof read>>
    if (!Array.isArray(report.data)) throw new Error('Apple 未返回有效版本数据')
    return report
  }
  const apps = await read(`https://api.appstoreconnect.apple.com/v1/apps?${new URLSearchParams({ 'filter[bundleId]': bundleId, limit: '2' })}`)
  if (apps.data.length !== 1 || apps.data[0].attributes.bundleId !== bundleId) throw new Error('App Store Connect 中未找到唯一匹配的应用')
  const observations: ReviewObservation[] = []
  let url: string | undefined = `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(apps.data[0].id)}/appStoreVersions?${new URLSearchParams({ 'filter[platform]': 'IOS', include: 'build', limit: '200' })}`
  for (let page = 0; url && page < 10; page++) {
    const report = await read(url)
    for (const row of report.data.sort((a, b) => (b.attributes.createdDate ?? '').localeCompare(a.attributes.createdDate ?? ''))) {
      const raw = row.attributes.appVersionState ?? row.attributes.appStoreState
      const status = appleReviewState(raw)
      const build = report.included?.find((item) => item.type === 'builds' && item.id === row.relationships?.build?.data?.id)
      observations.push({ store: 'apple', source: 'app_store_connect', status, version: row.attributes.versionString, build: build?.attributes.version,
        onlineVersion: status === 'live' ? row.attributes.versionString : undefined,
        detail: `${raw ?? '未知状态'}${status === 'rejected' ? '；公开 API 未提供审核拒绝消息，请在 App Store Connect 的 App 审核中查看原因' : ''}` })
    }
    url = report.links?.next
  }
  if (url) throw new Error('Apple 版本分页未完成，请减少历史版本后重试')
  return observations
}
