import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { coreStores, formatDate } from '../lib/meta'
import type { BootstrapData, StoreKey } from '../types'

export function CredentialsPage({ data, onConfigure }: { data: BootstrapData; onConfigure: (store: StoreKey) => void }) {
  return (
    <>
      <header className="page-header page-header--compact">
        <div><p className="eyebrow">安全中心</p><h1>平台凭证</h1><p>密钥加密保存在本机，页面不会读取或回显原文。</p></div>
        <span className="security-note"><ShieldCheck size={16} />AES-256-GCM 本地加密</span>
      </header>
      <section className="credential-grid">
        {coreStores.map((store) => {
          const credential = data.credentials.find(({ provider }) => provider === store)
          return (
            <article className="credential-card" key={store}>
              <div className="credential-card__top"><StoreMark store={store} /><StatusBadge status={credential?.validation_status ?? 'unverified'} /></div>
              {credential ? (
                <div className="credential-detail">
                  <p>{credential.label}</p>
                  <code>指纹 · {credential.fingerprint}</code>
                  <span>更新于 {formatDate(credential.updated_at)}</span>
                </div>
              ) : (
                <div className="credential-empty"><KeyRound size={18} /><p>尚未配置平台密钥</p></div>
              )}
              <button className={credential ? 'button button--quiet button--full' : 'button button--outline button--full'} onClick={() => onConfigure(store)}>
                {credential ? '更新凭证' : <><Plus size={16} />配置凭证</>}
              </button>
            </article>
          )
        })}
      </section>
    </>
  )
}
