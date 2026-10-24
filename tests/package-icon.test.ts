import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

test('APK configured adaptive resource wins over legacy placeholder; bitmap icons work and invalid icons fail', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'releaseport-icon-test-'))
  process.env.RELEASE_PORT_DATA_DIR = path.join(root, 'data')
  const { inspectPackageIcon, adaptStoreIcon } = await import('../server/package-icon.ts')
  const foreground = (await sharp({ create: { width: 108, height: 108, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer()).toString('base64')
  const legacy = (await sharp({ create: { width: 192, height: 192, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64')
  try {
    execFileSync('python3', ['-c', String.raw`import struct as s,zipfile,base64,sys,os
def chunk(kind,header,body): return s.pack('<HHI',kind,len(header)+8,len(header)+len(body)+8)+header+body
def pool(items):
 data=b''; offsets=[]
 for item in items:
  b=item.encode();offsets.append(len(data));data+=bytes([len(b),len(b)])+b+b'\0'
 data+=b'\0'*((-len(data))%4)
 return chunk(1,s.pack('<IIIII',len(items),0,256,28+4*len(items),0),s.pack('<'+'I'*len(items),*offsets)+data)
def typed(density,value):
 config=bytearray(64);s.pack_into('<I',config,0,64);s.pack_into('<H',config,14,density)
 header=s.pack('<BBHII',1,0,0,1,88)+config
 entry=s.pack('<HHI',8,0,0)+s.pack('<HBBI',8,0,3,value)
 return chunk(0x201,header,s.pack('<I',0)+entry)
pkg=chunk(0x200,s.pack('<I',127)+bytes(276),typed(640,0)+typed(65534,1))
table=chunk(2,s.pack('<I',1),pool(['res/placeholder.png','res/adaptive.xml'])+pkg)
ns='http://schemas.android.com/apk/res/android'
def node(name,attrs):
 ext=s.pack('<IIHHHHHH',0xffffffff,name,20,20,len(attrs),0,0,0)
 return chunk(0x102,s.pack('<II',1,0xffffffff),ext+b''.join(s.pack('<IIIHBBI',3,k,0xffffffff,8,0,t,v) for k,t,v in attrs))
xml=chunk(3,b'',pool(['manifest','application','icon',ns])+node(0,[])+node(1,[(2,1,0x7f010000)]))
for mode in ['adaptive','raster','invalid']:
 with zipfile.ZipFile(os.path.join(sys.argv[1],mode+'.apk'),'w') as z:
  if mode=='adaptive':
   z.writestr('AndroidManifest.xml',xml);z.writestr('resources.arsc',table)
   z.writestr('res/adaptive.xml','<adaptive-icon xmlns:android="'+ns+'"><background android:drawable="#000000"/><foreground android:drawable="res/right.png"/></adaptive-icon>')
   z.writestr('res/right.png',base64.b64decode(sys.argv[2]))
   z.writestr('res/placeholder.png',base64.b64decode(sys.argv[3]))
  else:
   z.writestr('AndroidManifest.xml','<manifest xmlns:android="'+ns+'"><application android:icon="res/icon.png"/></manifest>')
   z.writestr('res/icon.png',base64.b64decode(sys.argv[3]) if mode=='raster' else b'invalid image')
`, root, foreground, legacy])
    const adaptive = await inspectPackageIcon(path.join(root, 'adaptive.apk'))
    assert.equal(adaptive.kind, 'adaptive')
    const metadata = await sharp(adaptive.path).metadata()
    assert.equal(metadata.width, 512)
    assert.equal(metadata.height, 512)
    assert.equal(metadata.format, 'png')
    const { data } = await sharp(adaptive.path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.ok(data[0] >= 125 && data[0] <= 130, 'foreground alpha is rendered on the configured black background')
    assert.equal(data[1], 0)
    assert.equal(data[2], 0)
    assert.deepEqual(await inspectPackageIcon(path.join(root, 'adaptive.apk')), adaptive)
    const huawei = await adaptStoreIcon(adaptive.path, 'huawei')
    assert.equal((await sharp(huawei).metadata()).width, 216)
    assert.equal((await sharp(huawei).metadata()).height, 216)
    assert.equal(await adaptStoreIcon(adaptive.path, 'honor'), adaptive.path)
    const oversized = path.join(root, 'large-icon.png')
    writeFileSync(oversized, Buffer.concat([readFileSync(adaptive.path), Buffer.alloc(201 * 1024)]))
    await assert.rejects(adaptStoreIcon(oversized, 'honor'), /200 KB/)
    assert.equal((await inspectPackageIcon(path.join(root, 'raster.apk'))).kind, 'raster')
    await assert.rejects(inspectPackageIcon(path.join(root, 'invalid.apk')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
