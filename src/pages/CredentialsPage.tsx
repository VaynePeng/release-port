import { useState } from 'react'
import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { coreStores, formatDate } from '../lib/meta'
import type { BootstrapData, StoreKey } from '../types'

export function CredentialsPage({ data, onConfigure, onRefresh }: { data: BootstrapData; onConfigure: (store: StoreKey) => void; onRefresh: () => Promise<void> }) {
  const [validating, setValidating] = useState<Partial<Record<StoreKey, boolean>>>({})
  const [errors, setErrors] = useState<Partial<Record<StoreKey, string>>>({})

  async function validate(store: StoreKey) {
    setValidating((current) => ({ ...current, [store]: true }))
    setErrors((current) => ({ ...current, [store]: '' }))
    try {
      await api.validateCredential(store)
      await onRefresh()
    } catch (reason) {
      setErrors((current) => ({ ...current, [store]: reason instanceof Error ? reason.message : '校验请求失败，请重试' }))
    } finally {
      setValidating((current) => ({ ...current, [store]: false }))
    }
  }
  return (
    <>
      <header className="page-header page-header--compact">
        <div><p className="eyebrow">安全中心</p><h1>平台凭证</h1><p>密钥加密保存在本机，可在查看 / 编辑窗口显示明文。</p></div>
        <span className="security-note"><ShieldCheck size={16} />AES-256-GCM 本地加密</span>
      </header>
      <section className="credential-grid">
        {coreStores.map((store) => {
          const credential = data.credentials.find(({ provider }) => provider === store)
          const busy = validating[store] || credential?.validation_status === 'validating'
          return (
            <article className="credential-card" key={store}>
              <div className="credential-card__top"><StoreMark store={store} /><StatusBadge status={busy ? 'validating' : credential?.validation_status ?? 'unverified'} /></div>
              {credential ? (
                <div className="credential-detail">
                  <p>{credential.label}</p>
                  <code>指纹 · {credential.fingerprint}</code>
                  <span>更新于 {formatDate(credential.updated_at)}</span>
                  {credential.last_validated_at ? <span>校验于 {formatDate(credential.last_validated_at)}</span> : null}
                  <p role="status" className="credential-validation">{busy ? '正在连接平台校验…' : credential.validation_message || '尚未进行在线校验，请点击下方校验凭证。'}</p>
                </div>
              ) : (
                <div className="credential-empty"><KeyRound size={18} /><p>尚未配置平台密钥</p></div>
              )}
              {errors[store] ? <p role="alert" className="form-error">{errors[store]}</p> : null}
              {credential ? <button className="button button--outline button--full" disabled={busy} onClick={() => void validate(store)}>{busy ? '校验中…' : '校验凭证'}</button> : null}
              <button className={credential ? 'button button--quiet button--full' : 'button button--outline button--full'} disabled={busy} onClick={() => onConfigure(store)}>
                {credential ? '查看 / 编辑凭证' : <><Plus size={16} />配置凭证</>}
              </button>
            </article>
          )
        })}
      </section>
    </>
  )
}
