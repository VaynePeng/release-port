export function sanitizeReleaseLog(text: string, secrets: string[] = []) {
  let safe = text.replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[私钥已隐藏]')
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[已隐藏]')
    safe = safe.split(encodeURIComponent(secret)).join('[已隐藏]')
  }
  return safe.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:password|private_key|access_token|access_secret|client_secret|api_key|SIG)\s*[=:]\s*)(?:"[^"]*"|[^\s&,]+)/gi, '$1[已隐藏]')
    .slice(-16_000)
}

export function classifyReleaseError(error: string, fallback?: string) {
  if (/\[-20035\]|请求频率太快/.test(error)) return 'rate_limited'
  if (/\[-20014\]|密码错误/.test(error)) return 'auth_failed'
  return fallback || 'unknown'
}
