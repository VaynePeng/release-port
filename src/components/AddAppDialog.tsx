import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api'

export function AddAppDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setError('')
    try {
      await api.createApp({
        name: String(form.get('name') ?? ''),
        androidPackageName: String(form.get('androidPackageName') ?? ''),
        iosBundleId: String(form.get('iosBundleId') ?? ''),
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog dialog--small" role="dialog" aria-modal="true" aria-labelledby="add-app-title">
        <header><div><p className="eyebrow">应用资产</p><h2 id="add-app-title">添加应用</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></header>
        <form onSubmit={submit}>
          <label className="field"><span>应用名称</span><input name="name" required placeholder="例如：ReleasePort" autoFocus /></label>
          <label className="field"><span>Android 包名</span><input name="androidPackageName" placeholder="com.example.app" /></label>
          <label className="field"><span>iOS Bundle ID</span><input name="iosBundleId" placeholder="com.example.app" /></label>
          <p className="form-hint">至少填写一个平台标识；后续上传的安装包必须与它一致。</p>
          {error ? <p className="form-error">{error}</p> : null}
          <footer><button type="button" className="button button--quiet" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving}>{saving ? '保存中…' : '保存应用'}</button></footer>
        </form>
      </section>
    </div>
  )
}
