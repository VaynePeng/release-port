import { readFile } from 'node:fs/promises'

// fir's publish contract uploads cert.icon and cert.binary separately.
// ApkGo v4.2.4 only handles cert.binary, so prepare the icon before invoking it.
export async function uploadFirIcon(packageName: string, apiToken: string, iconPath: string, apiFetch: typeof fetch = fetch) {
  const response = await apiFetch('https://api.appmeta.cn/apps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'android', bundle_id: packageName, api_token: apiToken }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`fir.im 图标上传凭证请求失败（HTTP ${response.status}）`)
  const body = await response.json() as { cert?: { icon?: { key?: string; token?: string; upload_url?: string } } }
  const icon = body.cert?.icon
  if (!icon?.key || !icon.token || !icon.upload_url) throw new Error('fir.im 未返回完整的 cert.icon，无法上传必需的图标')
  const url = new URL(icon.upload_url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('fir.im 返回的图标上传地址不是有效 HTTPS 地址')
  const form = new FormData()
  form.set('key', icon.key)
  form.set('token', icon.token)
  form.set('file', new Blob([await readFile(iconPath)], { type: 'image/png' }), 'icon.png')
  const uploaded = await apiFetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
  if (!uploaded.ok) throw new Error(`fir.im 图标上传失败（HTTP ${uploaded.status}）`)
  const result = await uploaded.json() as { is_completed?: boolean }
  if (result.is_completed !== true) throw new Error('fir.im 未确认图标上传完成，已停止该渠道发布')
}
