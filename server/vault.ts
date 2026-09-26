import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

const keyPath = path.join(config.dataDir, '.vault-key')

function getKey() {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 })
    chmodSync(keyPath, 0o600)
  }
  const key = readFileSync(keyPath)
  if (key.length !== 32) throw new Error('本地凭证库密钥损坏')
  return key
}

export function encryptSecret(payload: Record<string, string>) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptSecret(encoded: string): Record<string, string> {
  const packed = Buffer.from(encoded, 'base64')
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()])
  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>
}

export function secretFingerprint(payload: Record<string, string>) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12)
}
