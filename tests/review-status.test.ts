import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { appleReviewState, queryAppleReview } from '../server/apple-review.ts'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey

test('Apple reads authenticated iOS versions and related builds, distinguishes rejection and release, validates pagination origin', async () => {
  const calls: string[] = []
  const apiFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    assert.match((init?.headers as Record<string, string>).Authorization, /^Bearer /)
    if (url.includes('/v1/apps?')) return json({ data: [{ id: 'app-id', attributes: { bundleId: 'com.test.app' } }] })
    assert.match(url, /filter%5Bplatform%5D=IOS/)
    assert.match(url, /include=build/)
    return json({ data: [
      { id: 'old', attributes: { versionString: '1.0', appStoreState: 'READY_FOR_SALE', createdDate: '2026-01-01' } },
      { id: 'new', attributes: { versionString: '2.0', appVersionState: 'REJECTED', createdDate: '2026-10-24' }, relationships: { build: { data: { id: 'b-2' } } } },
    ], included: [{ id: 'b-2', type: 'builds', attributes: { version: '23' } }] })
  }
  const credential = { issuer_id: 'issuer', key_id: 'key', private_key: privateKey }
  const report = await queryAppleReview(credential, 'com.test.app', apiFetch)
  assert.equal(calls.length, 2)
  assert.equal(report[0].status, 'rejected')
  assert.equal(report[0].version, '2.0')
  assert.equal(report[0].build, '23')
  assert.match(report[0].detail, /未提供审核拒绝消息/)
  assert.equal(report[1].status, 'live')
  for (const raw of ['IN_REVIEW','WAITING_FOR_REVIEW']) assert.equal(appleReviewState(raw), 'reviewing')
  assert.equal(appleReviewState('PENDING_DEVELOPER_RELEASE'), 'pending_developer_release')
  assert.equal(appleReviewState('DEVELOPER_REJECTED'), 'withdrawn')
  assert.equal(appleReviewState('NEW_UNDOCUMENTED_STATE'), 'unknown')
  await assert.rejects(queryAppleReview(credential, 'com.test.app', async () => json({}, 403)), /HTTP 403/)
  await assert.rejects(queryAppleReview(credential, 'com.test.app', async (url) => String(url).includes('/v1/apps?')
    ? json({ data: [{ id: 'app', attributes: { bundleId: 'com.test.app' } }] })
    : json({ data: [], links: { next: 'https://attacker.example/steal' } })), /无效分页/)
})

test('review sync matches exact submission, preserves history and last result on errors, never invents Xiaomi review status', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-review-'))
  process.env.RELEASE_PORT_DATA_DIR = root
  const { db } = await import('../server/db.ts')
  const { applyReviewObservation, matchesSubmission } = await import('../server/review-status.ts')
  const { androidObservation } = await import('../server/app-sync.ts')
  const { getReleaseDetails } = await import('../server/queries.ts')
  const now = '2026-10-24T00:00:00.000Z'
  db.prepare('INSERT INTO apps (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('app','Test',now,now)
  function add(id: string, build: string, date: string) {
    db.prepare(`INSERT INTO releases (id,app_id,platform,version_name,build_number,strategy,timezone,release_notes,status,created_at,finished_at)
      VALUES (?,'app','android','2.0',?,'automatic','Asia/Shanghai','notes','submitted',?,?)`).run(id,build,date,now)
    db.prepare(`INSERT INTO release_targets (id,release_id,store,status,progress_bytes,total_bytes,phase,updated_at,finished_at)
      VALUES (?,?,'oppo','submitted',100,100,'uploading',?,?)`).run(id,id,now,now)
  }
  try {
    add('old','22',now)
    add('new','23','2026-10-24T00:01:00.000Z')
    const observation = { store: 'oppo', status: 'rejected', detail: '截图不符 secret-value', source: 'apkgo_audit', version: '2.0', build: '23' }
    assert.equal(matchesSubmission({ version_name:'2.0',build_number:'23' }, { ...observation, build: undefined }), false)
    applyReviewObservation('app', { ...observation, build: '22' })
    assert.equal(getReleaseDetails('new')!.targets[0].status, 'submitted')
    applyReviewObservation('app', observation, ['secret-value'])
    const result = getReleaseDetails('new')!
    assert.equal(result.release.status, 'rejected')
    assert.equal(result.targets[0].review_status, 'rejected')
    assert.equal(result.targets[0].status_source, 'store_api')
    assert.equal(result.targets[0].phase, 'uploading')
    assert.equal(result.targets[0].progress_bytes, 100)
    assert.equal(result.targets[0].finished_at, now)
    assert.doesNotMatch(result.targets[0].review_detail as string, /secret-value/)
    assert.equal(getReleaseDetails('old')!.targets[0].status, 'submitted')
    applyReviewObservation('app', observation, ['secret-value'])
    assert.equal(getReleaseDetails('new')!.events.length, 1)
    applyReviewObservation('app', { ...observation, error:'HTTP 401', detail:'查询失败' })
    assert.equal(getReleaseDetails('new')!.targets[0].review_status, 'rejected')
    assert.equal(getReleaseDetails('new')!.targets[0].review_sync_error, 'HTTP 401')
    assert.equal(getReleaseDetails('new')!.targets[0].review_detail, result.targets[0].review_detail)
    db.prepare("UPDATE release_targets SET status='cancelled',status_source='user_confirmation' WHERE id='new'").run()
    applyReviewObservation('app', { ...observation, status:'reviewing' })
    assert.equal(getReleaseDetails('new')!.targets[0].status, 'cancelled')
    assert.equal(androidObservation({ store:'xiaomi',supported:true,state:'reviewing',version_name:'2.0' }).status,'unknown')
    assert.equal(androidObservation({ store:'honor',supported:true,state:'approved' }).status,'unknown')
    assert.equal(androidObservation({ store:'oppo',supported:false,state:'rejected' }).status,'unknown')
    const mapped = androidObservation({ store:'oppo',supported:true,state:'rejected',detail:'截图不符',version_name:'2.0',version_code:23 })
    assert.equal(mapped.detail,'截图不符')
    assert.equal(mapped.build,'23')
    db.prepare(`INSERT INTO release_targets (id,release_id,store,status,external_id,updated_at) VALUES ('honor','new','honor','submitted','rel-7',?)`).run(now)
    applyReviewObservation('app',{store:'honor',source:'honor_api',submissionId:'wrong',status:'rejected',detail:'旧任务消息'})
    assert.equal(db.prepare("SELECT status FROM release_targets WHERE id='honor'").get()?.status,'submitted')
    applyReviewObservation('app',{store:'honor',source:'honor_api',submissionId:'rel-7',status:'rejected',detail:'截图不符'})
    assert.equal(db.prepare("SELECT review_detail FROM release_targets WHERE id='honor'").get()?.review_detail,'截图不符')
  } finally { db.close(); rmSync(root,{recursive:true,force:true}) }
})

test('Google uses the official release lifecycle API and versionCode, never substitutes track rollout status for review status', async () => {
  const { queryGoogleReview, googleReviewState } = await import('../server/google-review.ts')
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  const credential = { package_name:'com.test.app', track:'beta', json_key:JSON.stringify({ client_email:'test@example.invalid',private_key:rsa }) }
  const apiFetch: typeof fetch = async (input, init) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      assert.equal(init?.method,'POST')
      assert.match(String(init?.body), /assertion=/)
      return json({ access_token:'test-token' })
    }
    assert.equal(String(input),'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.test.app/tracks/beta/releases')
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-token')
    return json({ releases:[{ track:'beta',releaseLifecycleState:'RELEASE_LIFECYCLE_STATE_NOT_APPROVED',activeArtifacts:[{ versionCode:23 }] }] })
  }
  const [result] = await queryGoogleReview(credential,'com.test.app',apiFetch)
  assert.equal(result.status,'rejected')
  assert.equal(result.build,'23')
  assert.equal(result.version,undefined)
  const { matchesSubmission } = await import('../server/review-status.ts')
  assert.equal(matchesSubmission({version_name:'2.0',build_number:'23'},result),true)
  assert.equal(matchesSubmission({version_name:'2.0',build_number:'22'},result),false)
  assert.match(result.detail,/Play Console/)
  assert.equal(googleReviewState('completed'),'unknown')
  assert.equal(googleReviewState('RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'),'pending_developer_release')
  await assert.rejects(queryGoogleReview(credential,'other.app',apiFetch),/包名/)
  await assert.rejects(queryGoogleReview(credential,'com.test.app',async () => json({},403)),/HTTP 403/)
})

test('Honor preserves the final submission ID and queries the exact official audit result', async () => {
  const { queryHonorReview, submissionIdsFromDone } = await import('../server/honor-review.ts')
  assert.deepEqual(submissionIdsFromDone({type:'done',results:[{store:'honor',success:true,external_id:'rel-7'},{store:'oppo',success:false,external_id:'bad'}]}),[{store:'honor',id:'rel-7'}])
  assert.deepEqual(submissionIdsFromDone({type:'result',results:[]}),[])
  const apiFetch: typeof fetch = async (input,init) => {
    const url = String(input)
    if (url.endsWith('/auth/token')) return json({access_token:'test-token'})
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-token')
    if (url.includes('/get-app-id?')) return json({code:0,data:[{appId:123,packageName:'com.test.app'}]})
    assert.ok(url.endsWith('/get-audit-result'))
    assert.deepEqual(JSON.parse(String(init?.body)),{appId:[{appId:123,releaseId:'rel-7'}]})
    return json({code:0,data:[{releaseId:'other',auditResult:1},{releaseId:'rel-7',auditResult:2,auditMessage:'截图不符合要求'}]})
  }
  const result = await queryHonorReview({client_id:'id',client_secret:'secret'},'com.test.app','rel-7',apiFetch)
  assert.equal(result.status,'rejected')
  assert.equal(result.detail,'截图不符合要求')
  const {matchesSubmission} = await import('../server/review-status.ts')
  assert.equal(matchesSubmission({version_name:'2.0',build_number:'23',external_id:'rel-7'},result),true)
  assert.equal(matchesSubmission({version_name:'2.0',build_number:'23',external_id:'other'},result),false)
  await assert.rejects(queryHonorReview({client_id:'id',client_secret:'secret'},'wrong.app','rel-7',apiFetch),/精确匹配/)
})
