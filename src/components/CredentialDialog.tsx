import { useEffect, useState } from 'react'
import { Eye, EyeOff, ShieldCheck, X } from 'lucide-react'
import { api } from '../lib/api'
import { storeMeta } from '../lib/meta'
import type { StoreKey } from '../types'

type CredentialField = { key: string; label: string; multiline?: boolean; optional?: boolean; plain?: boolean; placeholder?: string; options?: Array<{ value: string; label: string }> }

const fieldsByStore: Record<StoreKey, CredentialField[]> = {
  huawei: [{ key: 'service_account_json', label: 'Service Account JSON', multiline: true, placeholder: '粘贴完整 JSON 内容' }, { key: 'app_id', label: 'App ID（可选）', optional: true, plain: true }],
  xiaomi: [{ key: 'email', label: '开发者邮箱', plain: true }, { key: 'private_key', label: '接口密钥' }, { key: 'cert', label: '公钥证书 PEM / Base64（可选）', multiline: true, optional: true }],
  honor: [{ key: 'client_id', label: 'Client ID', plain: true }, { key: 'client_secret', label: 'Client Secret' }, { key: 'app_id', label: 'App ID（可选）', optional: true, plain: true }],
  oppo: [{ key: 'client_id', label: 'Client ID' }, { key: 'client_secret', label: 'Client Secret' }],
  vivo: [{ key: 'access_key', label: 'Access Key', plain: true }, { key: 'access_secret', label: 'Access Secret' }, { key: 'sandbox_access_key', label: '沙箱 Access Key（可选）', optional: true, plain: true }, { key: 'sandbox_access_secret', label: '沙箱 Access Secret（可选）', optional: true }],
  meizu: [{ key: 'client_id', label: 'Client ID', plain: true }, { key: 'client_secret', label: 'Client Secret' }],
  tencent: [{ key: 'user_id', label: 'User ID', plain: true }, { key: 'access_secret', label: 'Access Secret' }, { key: 'app_id', label: 'App ID（与映射二选一）', optional: true, plain: true }, { key: 'app_id_map', label: '包名到 App ID 的 JSON 映射（与 App ID 二选一）', optional: true, multiline: true, placeholder: '{"com.example.app":"123456"}' }],
  samsung: [{ key: 'service_account_id', label: 'Service Account ID', plain: true }, { key: 'private_key', label: 'RSA 私钥 PEM', multiline: true }, { key: 'content_id', label: 'Galaxy Store Content ID', plain: true }],
  googleplay: [{ key: 'json_key', label: 'Service Account JSON', multiline: true, placeholder: '粘贴完整 JSON 内容' }, { key: 'package_name', label: 'Android 包名', plain: true, placeholder: 'com.example.app' }, { key: 'track', label: '发布轨道', optional: true, options: [{ value: 'production', label: 'Production' }, { value: 'beta', label: 'Beta' }, { value: 'alpha', label: 'Alpha' }, { value: 'internal', label: 'Internal' }] }],
  pgyer: [{ key: 'api_key', label: 'API Key' }],
  fir: [{ key: 'api_token', label: 'API Token' }],
  apple: [{ key: 'issuer_id', label: 'Issuer ID' }, { key: 'key_id', label: 'Key ID' }, { key: 'private_key', label: '.p8 私钥内容', multiline: true }],
}

export function CredentialDialog({ store, configured, onClose, onSaved }: { store: StoreKey; configured: boolean; onClose: () => void; onSaved: () => void }) {
  const [visible, setVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(configured)
  const [loadError, setLoadError] = useState('')
  const fields = fieldsByStore[store]

  useEffect(() => {
    if (!configured) return
    let active = true
    api.readCredential(store).then(({ fields: saved }) => {
      if (active) setValues(saved)
    }).catch((reason: unknown) => {
      if (active) setLoadError(reason instanceof Error ? reason.message : '读取凭证失败，请关闭后重试')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [store, configured])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload: Record<string, string> = {}
    for (const field of fields) payload[field.key] = values[field.key] ?? field.options?.[0]?.value ?? ''
    if (store === 'tencent' && !payload.app_id && !payload.app_id_map) {
      setError('腾讯应用宝需要填写 App ID 或包名映射')
      return
    }
    setSaving(true)
    setError('')
    try {
      await api.saveCredential({ provider: store, label: `${storeMeta[store].name} 主账号`, fields: payload })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="credential-title">
        <header><div><p className="eyebrow">凭证保险库</p><h2 id="credential-title">{configured ? '查看 / 编辑' : '配置'} {storeMeta[store].name}</h2></div><button className="icon-button" title="关闭" disabled={saving} onClick={onClose}><X size={18} /></button></header>
        <div className="vault-banner"><ShieldCheck size={18} /><div><strong>仅保存在这台设备</strong><p>已保存内容会自动填入，点击“显示明文”即可查看；只需修改需要更新的字段，保存后自动校验。</p></div></div>
        <form onSubmit={submit}>
          {loading ? <p role="status" className="form-hint">正在读取本机凭证…</p> : null}
          {loadError ? <p role="alert" className="form-error">{loadError}</p> : null}
          {fields.map((field) => (
            <label className="field" key={field.key}><span>{field.label}</span>
              {field.options ? <select name={field.key} disabled={loading || !!loadError || saving} value={values[field.key] ?? field.options[0]?.value} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}>{field.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : field.multiline && visible ? <textarea name={field.key} rows={5} disabled={loading || !!loadError || saving} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} required={!field.optional} spellCheck={false} placeholder={field.placeholder} autoComplete="off" /> : <input name={field.key} disabled={loading || !!loadError || saving} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} type={field.plain || visible ? 'text' : 'password'} required={!field.optional} autoComplete="off" placeholder={field.placeholder} />}
            </label>
          ))}
          <button type="button" className="reveal-button" disabled={loading || !!loadError} aria-pressed={visible} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}{visible ? '隐藏明文' : '显示明文'}</button>
          {error ? <p className="form-error">{error}</p> : null}
          <footer><button type="button" className="button button--quiet" disabled={saving} onClick={onClose}>取消</button><button className="button button--primary" disabled={saving || loading || !!loadError}>{saving ? '保存并校验中…' : '保存并校验'}</button></footer>
        </form>
      </section>
    </div>
  )
}
