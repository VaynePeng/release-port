import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { inspectPackage, compareVersions, verifyPackageIdentity } from '../server/package-metadata.ts'

test('package readers preserve embedded version and build, reject malformed archives and wrong identities', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-package-test-'))
  try {
    execFileSync('python3', ['-c', `import zipfile,plistlib,sys
root=sys.argv[1]
manifest='<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app" android:versionName="1.10.0" android:versionCode="120"/>'
with zipfile.ZipFile(root+'/package.apk','w') as z: z.writestr('AndroidManifest.xml',manifest)
with zipfile.ZipFile(root+'/package.ipa','w') as z: z.writestr('Payload/Main.app/Info.plist',plistlib.dumps(dict(CFBundleIdentifier='com.example.app',CFBundleShortVersionString='1.10.0',CFBundleVersion='120'),fmt=plistlib.FMT_BINARY))
def varint(n):
 out=bytearray()
 while n>=128: out.append((n&127)|128);n>>=7
 out.append(n);return bytes(out)
def field(n,v):
 v=v.encode() if isinstance(v,str) else v
 return varint((n<<3)|2)+varint(len(v))+v
def attr(k,v): return field(2,k)+field(3,v)
element=field(3,'manifest')+b''.join(field(4,attr(k,v)) for k,v in [('package','com.example.app'),('versionName','1.10.0'),('versionCode','120')])
with zipfile.ZipFile(root+'/package.aab','w') as z: z.writestr('base/manifest/AndroidManifest.xml',field(1,element))
`, root])
    for (const extension of ['apk', 'aab', 'ipa']) {
      const metadata = await inspectPackage(path.join(root, `package.${extension}`), `package.${extension}`)
      assert.equal(metadata.versionName, '1.10.0')
      assert.equal(metadata.buildNumber, '120')
      assert.equal(metadata.packageName, 'com.example.app')
      assert.throws(() => verifyPackageIdentity(metadata, { android_package_name: 'wrong.app', ios_bundle_id: 'wrong.app' }, metadata.platform), /不一致/)
    }
    writeFileSync(path.join(root, 'broken.apk'), 'invalid archive')
    await assert.rejects(inspectPackage(path.join(root, 'broken.apk'), 'broken.apk'), /无法读取/)
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.0', '1.0.0'), 0)
    assert.equal(compareVersions('99999999999999999999', '99999999999999999998'), 1)
    assert.equal(compareVersions('v1.0', '1.0'), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('version policy blocks downgrades, duplicate builds, missing data and unsupported stores', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-version-test-'))
  process.env.RELEASE_PORT_DATA_DIR = root
  const { checkAndroidBaseline, checkPackageVersions } = await import('../server/version-check.ts')
  const { db } = await import('../server/db.ts')
  try {
    const metadata = { platform: 'android' as const, packageName: 'com.example.app', versionName: '1.10.0', buildNumber: '120' }
    const baseline = { store: 'xiaomi', supported: true, live_version_name: '1.9.0', live_version_code: 119 }
    assert.equal(checkAndroidBaseline(metadata, baseline).status, 'passed')
    assert.equal(checkAndroidBaseline({ ...metadata, buildNumber: '118' }, baseline).status, 'blocked')
    assert.equal(checkAndroidBaseline({ ...metadata, buildNumber: '119' }, baseline).status, 'blocked')
    assert.equal(checkAndroidBaseline({ ...metadata, versionName: '1.8.0' }, baseline).status, 'blocked')
    assert.equal(checkAndroidBaseline(metadata, { ...baseline, version_code: 121, version_name: '1.10.0' }).status, 'blocked')
    assert.equal(checkAndroidBaseline(metadata, { store: 'xiaomi', supported: true }).status, 'blocked')
    assert.equal(checkAndroidBaseline(metadata, { store: 'xiaomi', supported: true, live_version_name: '1.9.0' }).status, 'blocked')
    const checks = await checkPackageVersions(metadata, ['googleplay', 'pgyer', 'fir'])
    assert.equal(checks.length, 3)
    assert.ok(checks.every((row) => row.status === 'blocked'))
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
