import { useMemo, useState } from 'react'
import { CalendarClock, Check, ChevronLeft, ChevronRight, FileUp, ShieldCheck, X } from 'lucide-react'
import { api } from '../lib/api'
import { coreStores, scheduledReleaseStores, storeMeta } from '../lib/meta'
import { StoreMark } from './StoreMark'
import { PlatformGlyph } from './BrandIcon'
import type { BootstrapData, StoreKey } from '../types'

type Props = { data: BootstrapData; onClose: () => void; onCreated: () => void }

const strategies = [
  { value: 'automatic', label: '审核后自动发布', help: '现在送审，通过后由商店自动上架' },
  { value: 'manual', label: '审核后手动发布', help: '审核通过后保留，等待人工确认' },
  { value: 'scheduled_release', label: '商店定时发布', help: '现在送审，通过后不早于指定时间上架' },
  { value: 'upload_only', label: '仅上传构建', help: '上传安装包，不提交商店审核' },
] as const

export function NewReleaseDialog({ data, onClose, onCreated }: Props) {
  const [step, setStep] = useState(1)
  const [appId, setAppId] = useState(data.apps.find(({ android_package_name }) => android_package_name)?.id ?? data.apps[0]?.id ?? '')
  const [platform, setPlatform] = useState<'android' | 'ios'>('android')
  const [artifact, setArtifact] = useState<File | null>(null)
  const [versionName, setVersionName] = useState('')
  const [buildNumber, setBuildNumber] = useState('')
  const [stores, setStores] = useState<StoreKey[]>([])
  const [strategy, setStrategy] = useState<(typeof strategies)[number]['value']>('automatic')
  const [notes, setNotes] = useState('')
  const [submitAt, setSubmitAt] = useState('')
  const [releaseAt, setReleaseAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedApp = data.apps.find(({ id }) => id === appId)
  const toolReady = data.tools.find(({ name }) => name === (platform === 'android' ? 'apkgo' : 'fastlane'))?.installed === true
  const availableStores = useMemo(() => coreStores.filter((store) => storeMeta[store].platform === platform), [platform])
  const availableApps = data.apps.filter((app) => platform === 'android' ? Boolean(app.android_package_name) : Boolean(app.ios_bundle_id))
  const availableStrategies = platform === 'android' ? strategies.filter(({ value }) => value === 'automatic' || value === 'scheduled_release') : strategies
  const isAab = artifact?.name.toLowerCase().endsWith('.aab') === true
  const immediateStores = stores.filter((store) => store !== 'apple' && !scheduledReleaseStores.has(store))

  function choosePlatform(next: 'android' | 'ios') {
    setPlatform(next)
    setStores([])
    setArtifact(null)
    setStrategy('automatic')
    setReleaseAt('')
    const firstApp = data.apps.find((app) => next === 'android' ? app.android_package_name : app.ios_bundle_id)
    setAppId(firstApp?.id ?? '')
  }

  function chooseArtifact(file: File | null) {
    setArtifact(file)
    if (file?.name.toLowerCase().endsWith('.aab')) setStores((current) => current.filter((store) => store === 'googleplay'))
  }

  function toggleStore(store: StoreKey) {
    setStores((current) => current.includes(store) ? current.filter((item) => item !== store) : [...current, store])
  }

  function storeAcceptsArtifact(store: StoreKey) {
    return !isAab || store === 'googleplay'
  }

  function canContinue() {
    if (step === 1) return Boolean(appId && artifact && versionName)
    if (step === 2) return stores.length > 0 && stores.every(storeAcceptsArtifact)
    return Boolean(notes && (strategy !== 'scheduled_release' || releaseAt))
  }

  async function submit() {
    if (!artifact) return
    setSaving(true)
    setError('')
    const form = new FormData()
    form.set('artifact', artifact)
    form.set('appId', appId)
    form.set('platform', platform)
    form.set('versionName', versionName)
    form.set('buildNumber', buildNumber)
    form.set('stores', JSON.stringify(stores))
    form.set('strategy', strategy)
    form.set('releaseNotes', notes)
    form.set('submitAt', submitAt)
    form.set('storeReleaseAt', releaseAt)
    form.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
    try {
      await api.createRelease(form)
      onCreated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog release-dialog" role="dialog" aria-modal="true" aria-labelledby="release-title">
        <header>
          <div><p className="eyebrow">发布向导 · {step} / 3</p><h2 id="release-title">新建发布</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="stepper" aria-label="发布步骤">
          {['安装包', '目标渠道', '发布策略'].map((label, index) => <span key={label} className={step >= index + 1 ? 'is-active' : ''}><i>{step > index + 1 ? <Check size={12} /> : index + 1}</i>{label}</span>)}
        </div>

        <div className="release-dialog__body">
          <div className="release-dialog__form">
            {step === 1 ? (
              <div className="form-section">
                <label className="field"><span>选择应用</span><select value={appId} onChange={(event) => setAppId(event.target.value)}>{availableApps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</select></label>
                <div className="segmented"><button className={platform === 'android' ? 'is-active' : ''} onClick={() => choosePlatform('android')}><PlatformGlyph platform="android" />Android</button><button className={platform === 'ios' ? 'is-active' : ''} onClick={() => choosePlatform('ios')}><PlatformGlyph platform="ios" />iOS</button></div>
                <label className={artifact ? 'drop-zone has-file' : 'drop-zone'}>
                  <FileUp size={24} />
                  <strong>{artifact ? artifact.name : `选择 ${platform === 'android' ? 'APK / AAB' : 'IPA'} 文件`}</strong>
                  <span>{artifact ? `${(artifact.size / 1024 / 1024).toFixed(1)} MB` : '安装包只会保存在本机'}</span>
                  <input type="file" accept={platform === 'android' ? '.apk,.aab' : '.ipa'} onChange={(event) => chooseArtifact(event.target.files?.[0] ?? null)} />
                </label>
                <div className="field-row"><label className="field"><span>版本号</span><input value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="2.9.0" /></label><label className="field"><span>构建号</span><input value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} placeholder="290" /></label></div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="form-section">
                <div className={toolReady ? 'preflight-line is-ready' : 'preflight-line is-blocked'}><ShieldCheck size={18} /><div><strong>{platform === 'android' ? 'ApkGo' : 'fastlane'} {toolReady ? '已就绪' : '尚未安装'}</strong><p>{toolReady ? '执行引擎可以接收发布任务' : '请前往“运行设置”查看安装命令与操作步骤'}</p></div></div>
                <div className="store-options">
                  {availableStores.map((store) => {
                    const configured = data.credentials.some(({ provider }) => provider === store)
                    const checked = stores.includes(store)
                    const acceptsArtifact = storeAcceptsArtifact(store)
                    const disabled = !configured || !toolReady || !acceptsArtifact
                    const state = !acceptsArtifact ? '仅支持 APK' : configured ? (checked ? '已选择' : '可发布') : '缺少凭证'
                    return <button key={store} className={checked ? 'store-option is-selected' : 'store-option'} disabled={disabled} onClick={() => toggleStore(store)}><StoreMark store={store} /><span>{state}</span>{checked ? <Check size={16} /> : null}</button>
                  })}
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="form-section">
                <div className="strategy-options">
                  {availableStrategies.map((item) => <label key={item.value} className={strategy === item.value ? 'strategy-option is-selected' : 'strategy-option'}><input type="radio" name="strategy" value={item.value} checked={strategy === item.value} onChange={() => setStrategy(item.value)} /><span><strong>{item.label}</strong><small>{item.help}</small></span></label>)}
                </div>
                {strategy === 'scheduled_release' ? <label className="field"><span>商店发布时间</span><input type="datetime-local" value={releaseAt} onChange={(event) => setReleaseAt(event.target.value)} /></label> : null}
                {strategy === 'scheduled_release' && immediateStores.length ? <p className="schedule-warning">{immediateStores.map((store) => storeMeta[store].name).join('、')} 不支持商店定时发布，将在审核通过后立即上架。</p> : null}
                <label className="field"><span>定时开始提交 <small>可选</small></span><input type="datetime-local" value={submitAt} onChange={(event) => setSubmitAt(event.target.value)} /></label>
                <label className="field"><span>版本更新说明</span><textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="说明本次版本的主要变化" /></label>
              </div>
            ) : null}
          </div>

          <aside className="release-summary">
            <h3>任务摘要</h3>
            <dl><div><dt>应用</dt><dd>{selectedApp?.name ?? '未选择'}</dd></div><div><dt>平台</dt><dd>{platform === 'android' ? 'Android' : 'iOS'}</dd></div><div><dt>版本</dt><dd>{versionName ? `v${versionName}` : '待填写'}</dd></div><div><dt>目标</dt><dd>{stores.length ? `${stores.length} 个渠道` : '待选择'}</dd></div></dl>
            {stores.length ? <div className="summary-stores">{stores.map((store) => <StoreMark key={store} store={store} showName={false} />)}</div> : null}
            <div className="summary-note"><CalendarClock size={15} /><span>{submitAt ? '将在指定时间开始提交' : '确认后立即开始提交'}</span></div>
          </aside>
        </div>
        {error ? <p className="form-error dialog-error">{error}</p> : null}
        <footer className="dialog-footer">
          <button className="button button--quiet" disabled={step === 1 || saving} onClick={() => setStep((value) => value - 1)}><ChevronLeft size={16} />上一步</button>
          {step < 3 ? <button className="button button--primary" disabled={!canContinue()} onClick={() => setStep((value) => value + 1)}>继续<ChevronRight size={16} /></button> : <button className="button button--primary" disabled={!canContinue() || saving} onClick={submit}>{saving ? '创建任务中…' : '确认并创建任务'}</button>}
        </footer>
      </section>
    </div>
  )
}
