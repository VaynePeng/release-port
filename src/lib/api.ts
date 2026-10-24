import type { BootstrapData, ReleaseDetails, StoreKey } from '../types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: '请求失败' })) as { error?: string }
    throw new Error(body.error ?? `请求失败 (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export type PackageMetadata = { platform: 'android' | 'ios'; packageName: string; versionName: string; buildNumber: string; iconUrl?: string; iconError?: string }
export type VersionCheck = { store: string; status: 'passed' | 'blocked'; message: string; versionName?: string; buildNumber?: string }

export type CredentialValidation = { status: 'valid' | 'invalid' | 'unverified'; message: string }

export const api = {
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),
  releaseDetails: (id: string) => request<ReleaseDetails>(`/api/releases/${id}`),
  syncRelease: (id: string) => request<{ details: ReleaseDetails; updatedStores: StoreKey[]; warnings: string[] }>(`/api/releases/${id}/sync`, { method: 'POST' }),
  recordStoreCancellation: (releaseId: string, targetId: string) => request<ReleaseDetails>(`/api/releases/${releaseId}/targets/${targetId}/record-cancellation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }),
  createApp: (payload: { name: string; androidPackageName: string; iosBundleId: string }) => request<{ id: string }>('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  syncApp: (id: string) => request<{ updatedStores: StoreKey[]; warnings: string[] }>(`/api/apps/${id}/sync`, { method: 'POST' }),
  saveCredential: (payload: { provider: StoreKey; label: string; fields: Record<string, string> }) => request<{ id: string; fingerprint: string; validation: CredentialValidation }>('/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  validateCredential: (provider: StoreKey) => request<CredentialValidation>(`/api/credentials/${provider}/validate`, { method: 'POST' }),
  readCredential: (provider: StoreKey) => request<{ fields: Record<string, string> }>(`/api/credentials/${provider}/reveal`, {
    method: 'POST', headers: { 'X-ReleasePort-Credentials': 'reveal' },
  }),
  deleteCredential: (provider: StoreKey) => request<void>(`/api/credentials/${provider}`, { method: 'DELETE' }),
  inspectPackage: (file: File) => {
    const form = new FormData()
    form.set('artifact', file)
    return request<PackageMetadata>('/api/packages/inspect', { method: 'POST', body: form })
  },
  checkVersions: (metadata: PackageMetadata, stores: StoreKey[]) => request<{ checks: VersionCheck[] }>('/api/packages/check-versions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...metadata, stores }),
  }),
  createRelease: (form: FormData) => request<{ id: string; status: string; sha256: string }>('/api/releases', {
    method: 'POST',
    body: form,
  }),
}
