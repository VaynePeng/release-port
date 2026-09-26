import type { BootstrapData, StoreKey } from '../types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: '请求失败' })) as { error?: string }
    throw new Error(body.error ?? `请求失败 (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),
  createApp: (payload: { name: string; androidPackageName: string; iosBundleId: string }) => request<{ id: string }>('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  syncApp: (id: string) => request<{ updatedStores: StoreKey[]; warnings: string[] }>(`/api/apps/${id}/sync`, { method: 'POST' }),
  saveCredential: (payload: { provider: StoreKey; label: string; fields: Record<string, string> }) => request<{ id: string; fingerprint: string }>('/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  deleteCredential: (provider: StoreKey) => request<void>(`/api/credentials/${provider}`, { method: 'DELETE' }),
  createRelease: (form: FormData) => request<{ id: string; status: string; sha256: string }>('/api/releases', {
    method: 'POST',
    body: form,
  }),
}
