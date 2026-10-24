export type AndroidStoreKey =
  | 'huawei'
  | 'honor'
  | 'xiaomi'
  | 'oppo'
  | 'vivo'
  | 'meizu'
  | 'tencent'
  | 'samsung'
  | 'googleplay'
  | 'pgyer'
  | 'fir'

export type StoreKey = AndroidStoreKey | 'apple'

export type AppRecord = {
  id: string
  name: string
  android_package_name: string | null
  ios_bundle_id: string | null
  icon_url: string | null
  active_channels: number
  issue_channels: number
  created_at: string
  updated_at: string
}

export type ChannelRecord = {
  id: string
  app_id: string
  store: StoreKey
  platform: 'android' | 'ios'
  online_version: string | null
  review_version: string | null
  status: string
  raw_status: string | null
  last_synced_at: string | null
}

export type ReleaseRecord = {
  id: string
  app_id: string
  app_name: string
  platform: 'android' | 'ios'
  version_name: string
  build_number: string | null
  strategy: string
  submit_at: string | null
  store_release_at: string | null
  timezone: string
  release_notes: string
  status: string
  target_count: number
  failed_count: number
  created_at: string
  started_at?: string | null
  finished_at?: string | null
}

export type ReleaseTarget = {
  id: string
  release_id: string
  store: StoreKey
  status: string
  progress_bytes: number
  total_bytes: number
  error_category: string | null
  error_message: string | null
  updated_at: string
  phase: string | null
  phase_started_at: string | null
  started_at: string | null
  finished_at: string | null
  external_id?: string | null
  review_status?: string | null
  review_detail?: string | null
  review_source?: string | null
  review_checked_at?: string | null
  review_sync_error?: string | null
  status_source?: string | null
  status_note?: string | null
}

export type ReleaseDetails = {
  release: ReleaseRecord & { started_at: string | null; finished_at: string | null; artifact_name: string | null; artifact_size: number | null; artifact_sha256: string | null }
  targets: ReleaseTarget[]
  events: Array<{ id: string; target_id: string | null; event_type: string; message: string; created_at: string }>
}

export type CredentialRecord = {
  id: string
  provider: StoreKey
  label: string
  fingerprint: string
  validation_message: string | null
  validation_status: string
  last_validated_at: string | null
  updated_at: string
}

export type ToolStatus = {
  name: 'apkgo' | 'fastlane'
  installed: boolean
  version: string | null
}

export type BootstrapData = {
  apps: AppRecord[]
  channels: ChannelRecord[]
  releases: ReleaseRecord[]
  targets: ReleaseTarget[]
  credentials: CredentialRecord[]
  tools: ToolStatus[]
  summary: {
    apps: number
    activeReleases: number
    publishedReleases: number
    configuredCredentials: number
  }
}

export type ViewKey = 'overview' | 'apps' | 'releases' | 'credentials' | 'settings'
