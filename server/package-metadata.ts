import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export type PackageMetadata = { platform: 'android' | 'ios'; packageName: string; versionName: string; buildNumber: string }
const execute = promisify(execFile)
const script = fileURLToPath(new URL('./scripts/package_metadata.py', import.meta.url))

export async function inspectPackage(filePath: string, originalName: string): Promise<PackageMetadata> {
  try {
    const { stdout } = await execute('python3', [script, filePath, path.extname(originalName).toLowerCase()], { timeout: 20_000, maxBuffer: 64_000 })
    const metadata = JSON.parse(stdout) as PackageMetadata
    if (!['android', 'ios'].includes(metadata.platform) || !metadata.packageName || !metadata.versionName || !metadata.buildNumber) throw new Error('invalid metadata')
    return metadata
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('读取安装包需要本机 Python 3，请安装后重试')
    throw new Error('无法读取安装包的包名、版本号或构建号，请使用完整有效的 APK / AAB / IPA')
  }
}

export function compareVersions(left: string, right: string): number | null {
  if (!/^\d+(\.\d+)*$/.test(left) || !/^\d+(\.\d+)*$/.test(right)) return null
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0n, y = b[index] ?? 0n
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function verifyPackageIdentity(metadata: PackageMetadata, app: { android_package_name: string | null; ios_bundle_id: string | null }, platform: string) {
  if (metadata.platform !== platform) throw new Error('安装包平台与所选发布平台不一致')
  const expected = platform === 'android' ? app.android_package_name : app.ios_bundle_id
  if (!expected || metadata.packageName !== expected) throw new Error('安装包中的包名 / Bundle ID 与所选应用不一致')
}
