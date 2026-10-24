import type { AndroidStoreKey, StoreKey } from '../types'

export const storeMeta: Record<StoreKey, { name: string; short: string; color: string; platform: 'android' | 'ios' }> = {
  huawei: { name: '华为应用市场', short: 'HW', color: '#CF0A2C', platform: 'android' },
  xiaomi: { name: '小米应用商店', short: 'MI', color: '#FF6900', platform: 'android' },
  honor: { name: '荣耀应用市场', short: 'HO', color: '#000000', platform: 'android' },
  oppo: { name: 'OPPO 软件商店', short: 'OP', color: '#2AAD6F', platform: 'android' },
  vivo: { name: 'vivo 应用商店', short: 'VI', color: '#415FFF', platform: 'android' },
  meizu: { name: '魅族应用商店', short: 'MZ', color: '#00A7EA', platform: 'android' },
  tencent: { name: '腾讯应用宝', short: 'QQ', color: '#12B7F5', platform: 'android' },
  samsung: { name: 'Samsung Galaxy Store', short: 'SG', color: '#1428A0', platform: 'android' },
  googleplay: { name: 'Google Play', short: 'GP', color: '#01875F', platform: 'android' },
  pgyer: { name: '蒲公英', short: 'PGY', color: '#29BB9C', platform: 'android' },
  fir: { name: 'fir.im', short: 'fir', color: '#F28D35', platform: 'android' },
  apple: { name: 'Apple App Store', short: 'AS', color: '#0D96F6', platform: 'ios' },
}

export const androidStores = Object.keys(storeMeta).filter((store): store is AndroidStoreKey => storeMeta[store as StoreKey].platform === 'android')
export const scheduledReleaseStores = new Set<AndroidStoreKey>(['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'samsung', 'tencent'])

export const statusMeta: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  live: { label: '已发布', tone: 'success' },
  approved: { label: '审核通过', tone: 'success' },
  submitted: { label: '已提交', tone: 'info' },
  unknown: { label: '审核状态未知', tone: 'neutral' },
  withdrawn: { label: '已撤回 / 下架', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
  uploaded: { label: '已上传', tone: 'info' },
  reviewing: { label: '审核中', tone: 'warning' },
  pending_developer_release: { label: '等待发布', tone: 'warning' },
  scheduled: { label: '已计划', tone: 'info' },
  queued: { label: '等待执行', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  validating: { label: '正在验证', tone: 'info' },
  query: { label: '查询商店版本', tone: 'info' },
  metadata: { label: '更新版本资料', tone: 'info' },
  processing: { label: '等待构建处理', tone: 'info' },
  polling: { label: '等待商店处理', tone: 'info' },
  auth: { label: '正在鉴权', tone: 'info' },
  uploading: { label: '上传中', tone: 'info' },
  submitting: { label: '提交中', tone: 'info' },
  publishing: { label: '提交发布', tone: 'info' },
  icon_uploading: { label: '上传应用图标', tone: 'info' },
  partial_success: { label: '部分成功', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  rejected: { label: '已驳回', tone: 'danger' },
  unverified: { label: '未验证', tone: 'neutral' },
  invalid: { label: '校验未通过', tone: 'danger' },
  valid: { label: '可用', tone: 'success' },
}

export const coreStores = Object.keys(storeMeta) as StoreKey[]

export function formatDate(value: string | null, withTime = true) {
  if (!value) return '尚未同步'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: withTime ? '2-digit' : undefined,
    minute: withTime ? '2-digit' : undefined,
  }).format(new Date(value))
}
