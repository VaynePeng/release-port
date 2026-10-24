import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import sharp from 'sharp'
import { prepareAppleReleaseNotes, releaseNotesError, updateSamsungReleaseNotes } from '../server/release-notes.ts'

const notes = '新增训练统计\n修复“回放”问题，保留标点与换行。'
const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const apple = { key_id: 'test', issuer_id: 'test', private_key: ecKey }
const samsung = { service_account_id: 'test', content_id: 'test-content', private_key: rsaKey }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('release notes validation respects selected store limits', () => {
  assert.match(releaseNotesError(' \n ', ['apple'])!, /请填写/)
  assert.match(releaseNotesError('a'.repeat(501), ['googleplay'])!, /500/)
  assert.equal(releaseNotesError('a'.repeat(501), ['apple']), null)
  assert.match(releaseNotesError('新'.repeat(1334), ['samsung'])!, /4000 字节/)
})

test('Apple metadata uses the actual primary locale and preserves the complete notes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-apple-notes-'))
  try {
    const apiFetch: typeof fetch = async (url, init) => {
      assert.match(String(url), /filter%5BbundleId%5D=com.example.app/)
      assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer /)
      return json({ data: [{ attributes: { bundleId: 'com.example.app', primaryLocale: 'ja' } }] })
    }
    assert.equal(await prepareAppleReleaseNotes(apple, 'com.example.app', notes, root, apiFetch), 'ja')
    assert.equal(readFileSync(path.join(root, 'ja', 'release_notes.txt'), 'utf8'), notes)
    await assert.rejects(prepareAppleReleaseNotes(apple, 'com.example.app', notes, root, async () => json({ data: [] })), /无法确认/)
    await assert.rejects(prepareAppleReleaseNotes(apple, 'com.example.app', notes, root, async () => json({}, 403)), /HTTP 403/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function samsungApi(options: { rejected?: boolean; mismatch?: boolean } = {}) {
  let storedNotes = 'old notes'
  const apiFetch: typeof fetch = async (url, init) => {
    const address = String(url)
    if (address.endsWith('/auth/accessToken')) return json({ createdItem: { accessToken: 'fixture-token' } })
    assert.equal((init?.headers as Record<string, string>)['service-account-id'], 'test')
    if (address.includes('/contentInfo?')) return json([{ contentId: 'test-content', defaultLanguageCode: 'ENG', paid: 'N', usExportLaws: true, newFeature: storedNotes }])
    assert.ok(address.endsWith('/contentUpdate'))
    const body = JSON.parse(String(init?.body))
    assert.equal(body.newFeature, notes)
    assert.equal(body.defaultLanguageCode, 'ENG')
    assert.equal(body.paid, 'N')
    assert.equal(body.publicationType, '01')
    assert.equal(body.binaryList, undefined)
    if (!options.mismatch) storedNotes = body.newFeature
    return json({ resultCode: options.rejected ? '1001' : '0000' })
  }
  return apiFetch
}

test('Samsung writes newFeature and verifies the saved value; logical errors and mismatches fail', async () => {
  await updateSamsungReleaseNotes(samsung, notes, null, samsungApi())
  await assert.rejects(updateSamsungReleaseNotes(samsung, notes, null, samsungApi({ rejected: true })), /未被接受/)
  await assert.rejects(updateSamsungReleaseNotes(samsung, notes, null, samsungApi({ mismatch: true })), /回读不一致/)
})

test('version-checked releases preserve notes and stop on metadata failures', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-executor-notes-'))
  process.env.RELEASE_PORT_DATA_DIR = path.join(root, 'data')
  process.env.RELEASE_PORT_SEED_DEMO = 'false'
  const originalPath = process.env.PATH
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  process.env.PATH = `${bin}:${originalPath}`
  process.env.RELEASEPORT_TEST_CAPTURE = root
  const cli = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
if (args[0] === 'version' || args[0] === '--version') { console.log('{"version":"test"}'); process.exit(0) }
if (name === 'fastlane') {
  const metadataPath = args[args.indexOf('--metadata_path') + 1];
  const locale = fs.readdirSync(metadataPath)[0];
  fs.writeFileSync(path.join(process.env.RELEASEPORT_TEST_CAPTURE, 'apple.json'), JSON.stringify({ args, locale, notes: fs.readFileSync(path.join(metadataPath, locale, 'release_notes.txt'), 'utf8') }));
} else {
  let input = ''; process.stdin.on('data', part => input += part);
  process.stdin.on('end', () => {
    if (args[0] === 'audit') { console.log(JSON.stringify({ stores: Object.keys(JSON.parse(input).stores).map(store => ({ store, supported: true, version_name: '1.0.0', version_code: 1 })) })); return }
    const listing = args.includes('--listing') ? JSON.parse(fs.readFileSync(args[args.indexOf('--listing') + 1], 'utf8')) : undefined;
    fs.writeFileSync(path.join(process.env.RELEASEPORT_TEST_CAPTURE, 'android.json'), JSON.stringify({ args, listing }));
    if (fs.existsSync(path.join(process.env.RELEASEPORT_TEST_CAPTURE, 'incomplete-mode'))) return;
    const failed = fs.existsSync(path.join(process.env.RELEASEPORT_TEST_CAPTURE, 'limit-mode'));
    for (const store of Object.keys(JSON.parse(input).stores)) {
      console.log(JSON.stringify({ type: 'phase', store, phase: failed ? 'query' : 'uploading' }));
      if (!failed) {
        console.log(JSON.stringify({ type: 'total', store, total_bytes: 100 }));
        console.log(JSON.stringify({ type: 'bytes', store, sent: 100, total: 100 }));
        console.log(JSON.stringify({ type: 'phase', store, phase: 'publishing' }));
      }
      process.stdout.write(JSON.stringify({ type: 'result', store, success: !failed, duration_ms: 196, error: failed ? 'query: [-20035] 请求频率太快' : undefined }));
      if (store !== Object.keys(JSON.parse(input).stores).at(-1)) console.log();
    }
    if (failed) { console.error('Authorization: Bearer fixture-secret'); process.exitCode = 2; }
  });
}
`
  writeFileSync(path.join(bin, 'apkgo'), cli, { mode: 0o700 })
  writeFileSync(path.join(bin, 'fastlane'), cli, { mode: 0o700 })
  const { db } = await import('../server/db.ts')
  const { encryptSecret } = await import('../server/vault.ts')
  const { executeRelease } = await import('../server/executor.ts')
  const realFetch = globalThis.fetch
  const samsungFetch = samsungApi()
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('appstoreconnect.apple.com')) return samsungFetch(url, init)
    if (String(url).includes('/appStoreVersions') || String(url).includes('/builds?')) return json({ data: [] })
    return json({ data: [{ id: 'test-app', attributes: { bundleId: 'com.example.app', primaryLocale: 'zh-Hans' } }] })
  }
  t.after(() => { globalThis.fetch = realFetch; process.env.PATH = originalPath; db.close(); rmSync(root, { recursive: true, force: true }) })
  const now = new Date().toISOString()
  const fixtureIcon = (await sharp({ create: { width: 512, height: 512, channels: 3, background: '#123456' } }).png().toBuffer()).toString('base64')
  db.prepare('INSERT INTO apps (id, name, android_package_name, ios_bundle_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('app', 'Test', 'com.example.app', 'com.example.app', now, now)
  const stores = ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'meizu', 'tencent', 'samsung']
  for (const store of [...stores, 'apple']) {
    const fields = store === 'apple' ? apple : store === 'samsung' ? samsung : store === 'googleplay' ? { json_key: '{}' } : store === 'huawei' ? { service_account_json: '{}' } : { fixture: 'test' }
    db.prepare("INSERT INTO credentials (id, provider, label, encrypted_payload, fingerprint, validation_status, created_at, updated_at) VALUES (?, ?, 'Test', ?, 'test', 'valid', ?, ?)").run(store, store, encryptSecret(fields), now, now)
  }
  for (const platform of ['android', 'ios']) {
    const file = path.join(root, `test.${platform === 'ios' ? 'ipa' : 'apk'}`)
    execFileSync('python3', ['-c', `import zipfile,plistlib,sys,base64
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 if sys.argv[2] == 'ios': z.writestr('Payload/Test.app/Info.plist', plistlib.dumps(dict(CFBundleIdentifier='com.example.app', CFBundleShortVersionString='2.0.0', CFBundleVersion='2'), fmt=plistlib.FMT_BINARY))
 else:
  z.writestr('AndroidManifest.xml', '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app" android:versionName="2.0.0" android:versionCode="2"><application android:icon="res/icon.png"/></manifest>')
  z.writestr('res/icon.png',base64.b64decode(sys.argv[3]))`, file, platform, fixtureIcon])
    db.prepare('INSERT INTO artifacts (id, app_id, platform, file_path, original_name, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(platform, 'app', platform, file, 'test', 'test', 7, now)
    db.prepare("INSERT INTO releases (id, app_id, artifact_id, platform, version_name, build_number, strategy, timezone, release_notes, status, created_at) VALUES (?, 'app', ?, ?, '2.0.0', '2', 'automatic', 'Asia/Shanghai', ?, 'queued', ?)").run(platform, platform, platform, notes, now)
    for (const store of platform === 'ios' ? ['apple'] : stores) db.prepare("INSERT INTO release_targets (id, release_id, store, status, updated_at) VALUES (?, ?, ?, 'queued', ?)").run(store, platform, store, now)
    await executeRelease(platform)
  }
  const androidRun = JSON.parse(readFileSync(path.join(root, 'android.json'), 'utf8'))
  assert.equal(androidRun.args[androidRun.args.indexOf('--notes') + 1], notes)
  assert.deepEqual(androidRun.args[androidRun.args.indexOf('-s') + 1].split(',').sort(), [...stores].sort())
  assert.deepEqual(Object.keys(androidRun.listing.stores).sort(), ['honor', 'huawei', 'meizu', 'oppo', 'xiaomi'])
  const iconPath = androidRun.listing.stores.xiaomi.icon
  assert.equal((await sharp(iconPath).metadata()).width, 512)
  assert.equal((await sharp(iconPath).metadata()).format, 'png')
  assert.equal((await sharp(androidRun.listing.stores.huawei.icon).metadata()).width, 216)
  assert.ok(!existsSync(androidRun.args[androidRun.args.indexOf('--listing') + 1]))
  const appleRun = JSON.parse(readFileSync(path.join(root, 'apple.json'), 'utf8'))
  assert.equal(appleRun.notes, notes)
  assert.equal(appleRun.locale, 'zh-Hans')
  assert.equal(appleRun.args[appleRun.args.indexOf('--skip_metadata') + 1], 'false')
  assert.ok(appleRun.args.includes('--submit_for_review'))
  assert.ok(!existsSync(path.join(root, 'data', 'tmp', 'ios')))
  const targets = db.prepare('SELECT * FROM release_targets').all()
  assert.equal(targets.length, 9)
  assert.ok(targets.every((row) => row.status === 'submitted'))
  const xiaomiProgress = targets.find((row) => row.store === 'xiaomi')!
  assert.equal(xiaomiProgress.phase, 'publishing')
  assert.equal(xiaomiProgress.progress_bytes, 100)
  assert.equal(xiaomiProgress.total_bytes, 100)
  assert.ok(xiaomiProgress.started_at)
  assert.ok(xiaomiProgress.finished_at)
  writeFileSync(path.join(root, 'limit-mode'), '')
  await executeRelease('android')
  const limited = db.prepare("SELECT * FROM release_targets WHERE store = 'xiaomi'").get()!
  assert.equal(limited.phase, 'query')
  assert.equal(limited.status, 'failed')
  assert.equal(limited.error_category, 'rate_limited')
  const { getReleaseDetails } = await import('../server/queries.ts')
  const detail = getReleaseDetails('android')!
  assert.ok(detail.events.length > 0)
  assert.ok(!JSON.stringify(detail.events).includes('fixture-secret'))
  rmSync(path.join(root, 'limit-mode'))
  writeFileSync(path.join(root, 'incomplete-mode'), '')
  await executeRelease('android')
  assert.equal(db.prepare("SELECT status FROM releases WHERE id = 'android'").get()?.status, 'failed')
  assert.equal(db.prepare("SELECT error_category FROM release_targets WHERE store = 'xiaomi'").get()?.error_category, 'incomplete_result')
  rmSync(path.join(root, 'incomplete-mode'))

  const mismatchFetch = samsungApi({ mismatch: true })
  globalThis.fetch = async (url, init) => mismatchFetch(url, init)
  await executeRelease('android')
  const failedSamsung = db.prepare("SELECT status, error_category FROM release_targets WHERE store = 'samsung'").get()
  assert.equal(failedSamsung?.status, 'failed')
  assert.equal(failedSamsung?.error_category, 'release_notes_failed')
  const retry = JSON.parse(readFileSync(path.join(root, 'android.json'), 'utf8'))
  assert.ok(!retry.args[retry.args.indexOf('-s') + 1].split(',').includes('samsung'))
  execFileSync('python3', ['-c', `import zipfile,sys
p=sys.argv[1]
with zipfile.ZipFile(p) as z: entries={name:z.read(name) for name in z.namelist()}
entries['res/icon.png']=b'invalid icon'
with zipfile.ZipFile(p,'w') as z:
 for name,data in entries.items(): z.writestr(name,data)
`, path.join(root, 'test.apk')])
  await executeRelease('android')
  assert.equal(db.prepare("SELECT error_category FROM release_targets WHERE store = 'xiaomi'").get()?.error_category, 'icon_invalid')
  const invalidIconRun = JSON.parse(readFileSync(path.join(root, 'android.json'), 'utf8'))
  for (const store of ['huawei', 'honor', 'xiaomi', 'oppo', 'meizu']) {
    assert.ok(!invalidIconRun.args[invalidIconRun.args.indexOf('-s') + 1].split(',').includes(store))
    assert.equal(db.prepare('SELECT error_category FROM release_targets WHERE store = ?').get(store)?.error_category, 'icon_invalid')
  }
  assert.ok(!invalidIconRun.args.includes('--listing'))
  rmSync(path.join(root, 'apple.json'))
  globalThis.fetch = async () => json({ data: [] })
  await executeRelease('ios')
  assert.equal(db.prepare("SELECT error_category FROM release_targets WHERE store = 'apple'").get()?.error_category, 'version_check_failed')
  assert.ok(!existsSync(path.join(root, 'apple.json')))
  assert.ok(!existsSync(path.join(root, 'data', 'tmp', 'ios')))
})
