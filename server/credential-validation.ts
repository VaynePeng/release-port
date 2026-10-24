import { spawn } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { db } from './db.ts'
import { decryptSecret } from './vault.ts'

type Validation = { status: 'valid' | 'invalid' | 'unverified'; message: string }
type Probe = { name: string; status: string; detail?: string; error?: string }
type Report = { stores?: Array<{ store: string; supported: boolean; probes?: Probe[] }> }
const pending = new Map<string, Promise<Validation>>()

// A stopped server cannot finish an in-flight validation. Keep retries available.
db.prepare("UPDATE credentials SET validation_status = 'unverified', validation_message = '上次校验被中断，请重新校验' WHERE validation_status = 'validating'").run()

function doctor(provider: string, fields: Record<string, string>, packageName?: string) {
  return new Promise<Report>((resolve, reject) => {
    const args = ['doctor', '-s', provider, '--creds-from=stdin', '-o', 'json', '-t', '35s']
    if (packageName) args.push('-p', packageName)
    const child = spawn('apkgo', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('校验超时，请检查网络后重试')) }, 40_000)
    child.stdin.on('error', () => { /* Process errors are handled below. */ })
    child.stdin.end(JSON.stringify({ stores: { [provider]: fields } }))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 1_000_000) child.kill('SIGKILL')
    })
    // Never expose raw stderr: CLI diagnostics may contain credentials.
    child.stderr.resume()
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(error.code === 'ENOENT' ? '尚未安装 ApkGo，请在运行设置中安装后重试' : '无法启动 ApkGo 校验'))
    })
    child.on('close', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(output) as Report) }
      catch { reject(new Error('ApkGo 未返回有效校验结果，请检查工具版本及凭证格式')) }
    })
  })
}

function redact(message: string, fields: Record<string, string>) {
  let safe = message
  for (const value of Object.values(fields).sort((a, b) => b.length - a.length)) {
    if (value) safe = safe.split(value).join('[已隐藏]')
  }
  return safe.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 1500)
}

async function check(provider: string, fields: Record<string, string>): Promise<Validation> {
  if (provider === 'apple') {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: fields.key_id, typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iss: fields.issuer_id, iat: now, exp: now + 120, aud: 'appstoreconnect-v1' })).toString('base64url')
    const content = `${header}.${body}`
    let signature: string
    try {
      signature = sign('sha256', Buffer.from(content), { key: createPrivateKey(fields.private_key), dsaEncoding: 'ieee-p1363' }).toString('base64url')
    } catch { return { status: 'invalid', message: '无法解析或签署 Apple .p8 私钥，请检查私钥格式' } }
    const response = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=1', {
      headers: { Authorization: `Bearer ${content}.${signature}` }, signal: AbortSignal.timeout(35_000),
    })
    if (response.ok) return { status: 'valid', message: 'App Store Connect 鉴权通过，已确认应用列表读取权限' }
    return { status: response.status === 401 || response.status === 403 ? 'invalid' : 'unverified', message: `App Store Connect 校验未通过（HTTP ${response.status}）` }
  }
  if (provider === 'huawei' && fields.service_account_json) {
    fields = { ...fields, service_account: Buffer.from(fields.service_account_json).toString('base64') }
    delete fields.service_account_json
  }
  const apps = db.prepare("SELECT android_package_name FROM apps WHERE android_package_name IS NOT NULL AND android_package_name != '' ORDER BY updated_at DESC").all() as Array<{ android_package_name: string }>
  // Xiaomi has no auth-only probe, and querying requires an actual package.
  if (provider === 'xiaomi' && !apps.length) return { status: 'unverified', message: '凭证已保存；请先添加带 Android 包名的应用，再点击校验，以验证邮箱和私钥是否匹配' }
  const packageName = fields.package_name || apps[0]?.android_package_name
  const report = await doctor(provider, fields, packageName)
  const result = report.stores?.find((entry) => entry.store === provider)
  if (!result?.supported) return { status: 'unverified', message: '当前 ApkGo 版本不支持该渠道的在线凭证校验' }
  const probes = result.probes ?? []
  const failed = probes.filter((probe) => probe.status === 'fail')
  if (failed.length) return { status: 'invalid', message: failed.map((probe) => `${probe.name}：${probe.error || probe.detail || '校验未通过'}`).join('；') }
  const skipped = probes.filter((probe) => probe.status === 'skip')
  const remote = probes.filter((probe) => probe.status === 'ok' && probe.name !== 'cert' && probe.name !== 'config')
  if (!remote.length || skipped.length || probes.some((probe) => probe.status !== 'ok')) {
    return { status: 'unverified', message: `校验尚未完成${skipped.length ? `：${skipped.map((probe) => `${probe.name} ${probe.detail || '已跳过'}`).join('；')}` : '：仅完成本地检查'}` }
  }
  return { status: 'valid', message: `在线校验通过${packageName ? `（包名：${packageName}）` : ''}：${remote.map((probe) => probe.name).join('、')}；不代表发布流程已验收` }
}

export function validateCredential(provider: string): Promise<Validation> {
  const row = db.prepare('SELECT encrypted_payload FROM credentials WHERE provider = ?').get(provider) as { encrypted_payload: string } | undefined
  if (!row) throw new Error('尚未配置该平台凭证')
  const key = `${provider}:${row.encrypted_payload}`
  const existing = pending.get(key)
  if (existing) return existing
  db.prepare("UPDATE credentials SET validation_status = 'validating', validation_message = '正在连接平台校验…', last_validated_at = NULL WHERE provider = ?").run(provider)
  const task = (async () => {
    let fields: Record<string, string> = {}
    let result: Validation
    try {
      fields = decryptSecret(row.encrypted_payload)
      result = await check(provider, fields)
    } catch (error) {
      result = { status: 'unverified', message: error instanceof Error ? error.message : '校验未完成，请重试' }
    }
    result.message = redact(result.message, fields)
    // Updating/replacing a credential while a probe runs must discard the old result.
    db.prepare('UPDATE credentials SET validation_status = ?, validation_message = ?, last_validated_at = ? WHERE provider = ? AND encrypted_payload = ?')
      .run(result.status, result.message, new Date().toISOString(), provider, row.encrypted_payload)
    return result
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
