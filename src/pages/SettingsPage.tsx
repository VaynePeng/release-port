import { useState } from 'react'
import { Check, CheckCircle2, CircleAlert, Copy, Database, ExternalLink, HardDrive, LockKeyhole, TerminalSquare } from 'lucide-react'
import type { BootstrapData } from '../types'
import { ToolLogo } from '../components/BrandIcon'

export function SettingsPage({ data }: { data: BootstrapData }) {
  const [copied, setCopied] = useState(false)
  const apkgoInstallCommand = 'curl -fsSL https://apkgo.com.cn/install.sh | APKGO_INSTALL_DIR="$HOME/.local/bin" sh'

  async function copyInstallCommand() {
    await navigator.clipboard.writeText(apkgoInstallCommand)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_800)
  }

  return (
    <>
      <header className="page-header page-header--compact">
        <div><p className="eyebrow">本机环境</p><h1>运行设置</h1><p>发布任务离开浏览器后仍由本地服务继续执行。</p></div>
      </header>
      <div className="settings-layout">
        <section className="settings-section">
          <div className="section-heading"><TerminalSquare size={18} /><div><h2>发布工具</h2><p>执行引擎由本地服务直接调用</p></div></div>
          <div className="tool-list">
            {data.tools.map((tool) => (
              <div className="tool-entry" key={tool.name}>
                <article>
                  <ToolLogo tool={tool.name} />
                  <div><strong>{tool.name === 'apkgo' ? 'Android 发布引擎' : 'iOS 发布引擎'}</strong><p>{tool.installed ? tool.version : '未在 PATH 中发现'}</p></div>
                  <span className={tool.installed ? 'tool-state is-ready' : 'tool-state is-missing'}>{tool.installed ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}{tool.installed ? '已就绪' : '未安装'}</span>
                </article>
                {tool.name === 'apkgo' && !tool.installed ? (
                  <div className="install-guide">
                    <div><strong>安装 ApkGo</strong><p>在终端执行免 sudo 安装命令。安装后若仍未识别，请确认 ~/.local/bin 已加入 PATH 并重启本地服务。</p></div>
                    <div className="install-command"><code>{apkgoInstallCommand}</code><button className="icon-button icon-button--small" title="复制安装命令" onClick={() => void copyInstallCommand()}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
                    <div className="install-guide__footer"><span>商业使用前请确认 ApkGo 授权。</span><a href="https://github.com/KevinGong2013/apkgo" target="_blank" rel="noreferrer">查看官方文档<ExternalLink size={13} /></a></div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-heading"><LockKeyhole size={18} /><div><h2>本地数据</h2><p>所有敏感数据只保留在这台设备</p></div></div>
          <div className="setting-rows">
            <article><Database size={17} /><div><strong>状态数据库</strong><p>SQLite · WAL 模式</p></div><span>data/release-port.db</span></article>
            <article><HardDrive size={17} /><div><strong>安装包目录</strong><p>任务完成后按保留策略清理</p></div><span>uploads/</span></article>
            <article><LockKeyhole size={17} /><div><strong>凭证保险库</strong><p>独立随机密钥 · 文件权限 0600</p></div><span>本机加密</span></article>
          </div>
        </section>
      </div>
    </>
  )
}
