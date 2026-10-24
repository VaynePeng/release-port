import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, existsSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.ts'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./scripts/apk_icon.py', import.meta.url))
type Layer = { data?: string; resource?: string; color?: string; alpha?: number }
type Icon = { kind: 'adaptive' | 'raster'; resource: string; background?: Layer; foreground: Layer }
const pending = new Map<string, Promise<{ path: string; url: string; kind: Icon['kind'] }>>()

export async function inspectPackageIcon(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  const key = hash.digest('hex')
  const existing = pending.get(key)
  if (existing) return existing
  const task = prepare(filePath, key).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

async function prepare(filePath: string, key: string) {
  const dir = path.join(config.dataDir, 'package-icons')
  const dest = path.join(dir, `${key}.png`)
  const facts = path.join(dir, `${key}.json`)
  let kind: Icon['kind']
  if (existsSync(dest) && existsSync(facts)) {
    // Read the small sidecar without loading the icon or package again.
    kind = JSON.parse(await readFile(facts, 'utf8')).kind
  } else {
    let icon: Icon
    try {
      const { stdout } = await execute('python3', [script, filePath], { timeout: 20_000, maxBuffer: 48 * 1024 * 1024 })
      icon = JSON.parse(stdout) as Icon
    } catch (error) {
      let reason = ''
      try { reason = String(JSON.parse(String((error as { stdout?: string }).stdout)).error || '').slice(0, 300) } catch { /* No structured parser error. */ }
      throw new Error(`无法从 APK 可靠解析商店图标，已停止发布以避免覆盖为错误图标${reason ? `：${reason}` : ''}`)
    }
    kind = icon.kind
    const input = (layer: Layer) => {
      if (layer.data) return sharp(Buffer.from(layer.data, 'base64'), { limitInputPixels: 4096 * 4096 })
      if (layer.color) return sharp({ create: { width: 512, height: 512, channels: 4, background: { ...sharpColor(layer.color), alpha: layer.alpha ?? 1 } } })
      throw new Error('安装包图标缺少有效图层')
    }
    let png: Buffer
    if (kind === 'adaptive') {
      if (!icon.background) throw new Error('自适应图标缺少背景')
      // Android adaptive icons use a 108dp layer with a 72dp visible viewport.
      const foreground = await input(icon.foreground).resize(768, 768, { fit: 'fill' }).extract({ left: 128, top: 128, width: 512, height: 512 }).png().toBuffer()
      const background = await input(icon.background).resize(768, 768, { fit: 'fill' }).extract({ left: 128, top: 128, width: 512, height: 512 }).png().toBuffer()
      png = await sharp(background).composite([{ input: foreground }]).png().toBuffer()
    } else {
      png = await input(icon.foreground).resize(512, 512, { fit: 'contain', background: '#ffffff' }).png().toBuffer()
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(dest, png, { mode: 0o600 })
    writeFileSync(facts, JSON.stringify({ kind, resource: icon.resource, foreground: icon.foreground.resource, background: icon.background?.resource }), { mode: 0o600 })
  }
  return { path: dest, url: `/api/package-icons/${key}.png`, kind }
}

export async function adaptStoreIcon(iconPath: string, store: string) {
  let result = iconPath
  if (store === 'huawei') {
    result = iconPath.replace(/\.png$/, '.huawei.png')
    if (!existsSync(result)) {
      const png = await sharp(iconPath).resize(216, 216).png({ compressionLevel: 9 }).toBuffer()
      const temp = `${result}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, png, { mode: 0o600 })
      renameSync(temp, result)
    }
  }
  const maxBytes = store === 'honor' ? 200 * 1024 : store === 'huawei' ? 500 * 1024 : store === 'oppo' ? 1024 * 1024 - 1 : null
  if (maxBytes && statSync(result).size > maxBytes) throw new Error(`${store} 图标超过渠道限制（${Math.round(maxBytes / 1024)} KB），已停止该渠道发布`)
  return result
}

function sharpColor(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('安装包图标背景颜色格式不支持')
  return { r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) }
}
