import type { ReviewObservation } from './review-status.ts'

export async function queryHonorReview(credentials: Record<string,string>, packageName: string, releaseId: string, apiFetch: typeof fetch = fetch): Promise<ReviewObservation> {
  const auth = await apiFetch('https://iam.developer.honor.com/auth/token', { method:'POST',redirect:'error',
    body:new URLSearchParams({ client_id:credentials.client_id,client_secret:credentials.client_secret,grant_type:'client_credentials' }),signal:AbortSignal.timeout(20_000) })
  if (!auth.ok) throw new Error(`荣耀鉴权失败（HTTP ${auth.status}）`)
  const token = (await auth.json() as {access_token?:string}).access_token
  if (!token) throw new Error('荣耀未返回访问令牌')
  const base = 'https://appmarket-openapi-drcn.cloud.honor.com/openapi/v1/publish'
  async function read(route: string, init?: RequestInit) {
    const response = await apiFetch(`${base}/${route}`, { ...init,redirect:'error',headers:{ Authorization:`Bearer ${token}`,'Content-Type':'application/json' },signal:AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`荣耀审核查询失败（HTTP ${response.status}）`)
    const report = await response.json() as {code:number;data?:unknown}
    if (report.code !== 0) throw new Error(`荣耀审核查询失败（code ${report.code}）`)
    return report.data
  }
  const apps = await read(`get-app-id?${new URLSearchParams({pkgName:packageName})}`) as Array<{packageName:string;appId:number}>
  const app = Array.isArray(apps) ? apps.find((row) => row.packageName === packageName && Number.isSafeInteger(row.appId) && row.appId > 0) : undefined
  if (!app) throw new Error('荣耀未返回精确匹配的包名和 appId')
  const results = await read('get-audit-result',{method:'POST',body:JSON.stringify({appId:[{appId:app.appId,releaseId}]})}) as Array<{releaseId:string;auditResult:number;auditMessage?:string}>
  const result = Array.isArray(results) ? results.find((row) => row.releaseId === releaseId) : undefined
  if (!result) throw new Error('荣耀未返回本次 releaseId 对应的审核结果')
  return {store:'honor',source:'honor_api',submissionId:releaseId,
    status:({0:'reviewing',1:'approved',2:'rejected'} as Record<number,string>)[result.auditResult] ?? 'unknown',
    detail:result.auditMessage || `auditResult=${result.auditResult}；商店未返回详细审核意见`}
}

export function submissionIdsFromDone(event: Record<string,unknown>) {
  if (event.type !== 'done' || !Array.isArray(event.results)) return []
  return event.results.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const result = row as Record<string,unknown>
    return result.success === true && typeof result.store === 'string' && typeof result.external_id === 'string' && result.external_id.trim()
      ? [{store:result.store,id:result.external_id}] : []
  })
}
