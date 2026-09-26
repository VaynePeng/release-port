import { spawnSync } from 'node:child_process'

export type ToolStatus = {
  name: 'apkgo' | 'fastlane'
  installed: boolean
  version: string | null
}

function inspectTool(name: ToolStatus['name'], args: string[], parse?: (output: string) => string | null): ToolStatus {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 5_000 })
  if (result.error || result.status !== 0) return { name, installed: false, version: null }
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return { name, installed: true, version: parse ? parse(output) : output.split('\n').find(Boolean) ?? null }
}

export function getToolStatus() {
  return [
    inspectTool('apkgo', ['version', '-o', 'json'], (output) => {
      try {
        return `v${(JSON.parse(output) as { version: string }).version}`
      } catch {
        return output.split('\n').find(Boolean) ?? null
      }
    }),
    inspectTool('fastlane', ['--version']),
  ]
}
