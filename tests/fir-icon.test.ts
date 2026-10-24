import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { uploadFirIcon } from '../server/fir-icon.ts'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('fir uploads cert.icon separately, requires confirmation, and does not upload the package', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'releaseport-fir-icon-'))
  const file = path.join(dir, 'icon.png')
  writeFileSync(file, 'fixture image bytes')
  try {
    const calls: string[] = []
    const apiFetch: typeof fetch = async (url, init) => {
      calls.push(String(url))
      if (calls.length === 1) {
        assert.equal(String(url), 'https://api.appmeta.cn/apps')
        assert.deepEqual(JSON.parse(String(init?.body)), { type: 'android', bundle_id: 'com.example.app', api_token: 'fixture-token' })
        return json({ cert: { icon: { key: 'icon-key', token: 'icon-token', upload_url: 'https://upload.example.com/icon' }, binary: { key: 'must-not-use' } } })
      }
      assert.equal(String(url), 'https://upload.example.com/icon')
      const body = init?.body as FormData
      assert.equal(body.get('key'), 'icon-key')
      assert.equal(body.get('token'), 'icon-token')
      assert.equal((body.get('file') as File).type, 'image/png')
      assert.equal(await (body.get('file') as File).text(), 'fixture image bytes')
      assert.equal(body.get('x:version'), null)
      return json({ is_completed: true })
    }
    await uploadFirIcon('com.example.app', 'fixture-token', file, apiFetch)
    assert.equal(calls.length, 2)
    await assert.rejects(uploadFirIcon('com.example.app', 'fixture-token', file, async () => json({}, 403)), /HTTP 403/)
    await assert.rejects(uploadFirIcon('com.example.app', 'fixture-token', file, async () => json({ cert: { binary: {} } })), /cert.icon/)
    const rejected: typeof fetch = async (url) => String(url).includes('/apps')
      ? json({ cert: { icon: { key: 'key', token: 'token', upload_url: 'https://upload.example.com/icon' } } }) : json({ is_completed: false })
    await assert.rejects(uploadFirIcon('com.example.app', 'fixture-token', file, rejected), /未确认/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

