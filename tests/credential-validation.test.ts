import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

// Isolate the API, database, vault and CLI; never read real platform credentials.
test('credential save and validation lifecycle', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-validation-'))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'apkgo'), `#!${process.execPath}
let input = ''; process.stdin.setEncoding('utf8');
if (process.argv[2] === 'version') { console.log('{"version":"test"}'); process.exit(0) }
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const config = JSON.parse(input), provider = Object.keys(config.stores)[0], fields = config.stores[provider];
  if (process.argv[2] === 'audit') { console.log('{"stores":[]}'); return }
  if (fields.private_key === 'slow') await new Promise(r => setTimeout(r, 800));
  if (fields.private_key === 'timeout') { setInterval(() => {}, 1000); return }
  if (fields.private_key === 'malformed') { console.log('bad JSON'); return }
  const status = fields.private_key === 'bad' ? 'fail' : fields.private_key === 'skip' ? 'skip' : 'ok';
  const probes = [{ name: 'cert', status: 'ok' }, { name: 'query', status, error: fields.email + ' ' + fields.private_key }];
  console.log(JSON.stringify({ stores: [{ store: provider, supported: fields.private_key !== 'unsupported', probes }] }));
  if (status === 'fail') process.exitCode = 1;
});
`, { mode: 0o700 })
  writeFileSync(path.join(bin, 'fastlane'), `#!${process.execPath}\nconsole.log('test')\n`, { mode: 0o700 })
  const port = 18000 + Math.floor(Math.random() * 20000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_PORT_API_PORT: String(port), RELEASE_PORT_DATA_DIR: path.join(root, 'data'), RELEASE_PORT_UPLOAD_DIR: path.join(root, 'uploads'), RELEASE_PORT_SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit') }; rmSync(root, { recursive: true, force: true }) })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok } catch { /* Wait for isolated API. */ }
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(ready, `isolated API starts: ${logs}`)
  async function post(route: string, body?: unknown) {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    assert.ok(response.ok, `${route}: HTTP ${response.status}`)
    return response.json()
  }
  const save = (key: string) => post('credentials', { provider: 'xiaomi', label: 'Test', fields: { email: 'owner@example.invalid', private_key: key } })
  const snapshot = async () => (await (await fetch(`${base}/api/bootstrap`)).json()).credentials[0]

  await t.test('without a package it stays unverified with an actionable reason', async () => {
    const result = await save('good')
    assert.equal(result.validation.status, 'unverified')
    assert.match(result.validation.message, /Android 包名/)
  })
  await t.test('plaintext is available only through explicit local reveal, without changing saved credentials', async () => {
    const before = await snapshot()
    const denied = await fetch(`${base}/api/credentials/xiaomi/reveal`, { method: 'POST' })
    assert.equal(denied.status, 403)
    const foreign = await fetch(`${base}/api/credentials/xiaomi/reveal`, { method: 'POST', headers: { 'X-ReleasePort-Credentials': 'reveal', Origin: 'https://example.com' } })
    assert.equal(foreign.status, 403)
    const response = await fetch(`${base}/api/credentials/xiaomi/reveal`, { method: 'POST', headers: { 'X-ReleasePort-Credentials': 'reveal' } })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const saved = await response.json()
    assert.deepEqual(saved.fields, { email: 'owner@example.invalid', private_key: 'good' })
    assert.deepEqual(await snapshot(), before)
    await post('credentials', { provider: 'xiaomi', label: 'Test', fields: { ...saved.fields, email: 'updated@example.invalid' } })
    const edited = await (await fetch(`${base}/api/credentials/xiaomi/reveal`, { method: 'POST', headers: { 'X-ReleasePort-Credentials': 'reveal' } })).json()
    assert.equal(edited.fields.private_key, 'good')
    assert.equal(edited.fields.email, 'updated@example.invalid')
  })
  await post('apps', { name: 'Test app', androidPackageName: 'com.example.test' })
  await t.test('save runs online validation and persists its timestamp', async () => {
    assert.equal((await save('good')).validation.status, 'valid')
    const row = await snapshot()
    assert.equal(row.validation_status, 'valid')
    assert.ok(row.last_validated_at)
    assert.match(row.validation_message, /com.example.test/)
    assert.equal(row.encrypted_payload, undefined)
  })
  await t.test('failure is retained even when CLI exits nonzero and secrets are redacted', async () => {
    const result = await save('bad')
    assert.equal(result.validation.status, 'invalid')
    assert.ok(!result.validation.message.includes('owner@example.invalid'))
    assert.ok(!result.validation.message.includes('bad'))
    assert.equal((await snapshot()).validation_status, 'invalid')
    assert.equal((await post('credentials/xiaomi/validate')).status, 'invalid')
  })
  for (const key of ['skip', 'unsupported', 'malformed']) {
    await t.test(`${key} cannot produce a valid credential`, async () => {
      assert.equal((await save(key)).validation.status, 'unverified')
    })
  }
  await t.test('a stale validation cannot overwrite replacement credentials', async () => {
    const slow = save('slow')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal((await snapshot()).validation_status, 'validating')
    assert.equal((await save('bad')).validation.status, 'invalid')
    await slow
    assert.equal((await snapshot()).validation_status, 'invalid')
  })
  await t.test('hung probes time out and remain retryable', async () => {
    const result = await save('timeout')
    assert.equal(result.validation.status, 'unverified')
    assert.match(result.validation.message, /超时/)
    assert.equal((await save('good')).validation.status, 'valid')
  })
})
