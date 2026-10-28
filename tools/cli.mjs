#!/usr/bin/env node
/**
 * tools/cli.mjs —— 不开 DSH 也能用（也是插件的自测入口）
 * ============================================================================
 * 用法：
 *   node tools/cli.mjs status [--verbose]
 *   node tools/cli.mjs scan <目录> [--recursive] [--json]
 *   node tools/cli.mjs distill <视频> [--force] [--frames 6] [--backend auto|local|api|...] [--json]
 *   node tools/cli.mjs guide
 *   node tools/cli.mjs asr-install [--model small] [--no-model] [--wait]
 *
 * 它跟插件走**同一份 lib/**，所以这里是"插件里那条链路能不能跑通"的最快验证方式。
 * ============================================================================
 */
import { existsSync, statSync } from 'node:fs'
import {
  HOME_DIR, INSTALL_LOG, loadConfig, resolveFfmpeg, readSecretKey, maskKey,
} from '../lib/env.mjs'
import { probeVideo, scanDir } from '../lib/media.mjs'
import { compactBundle, distillOne } from '../lib/distill.mjs'
import { apiStatus, localStatus } from '../lib/asr.mjs'
import { envReport, installLogTail, installState, startInstall } from '../lib/install.mjs'
import { guideText } from '../lib/guide.mjs'

const argv = process.argv.slice(2)
const cmd = String(argv[0] || 'status')
const flag = (name) => argv.includes(`--${name}`)
const val = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1] || '').startsWith('--'))
const wantJson = flag('json')

const log = (s) => process.stderr.write(`${s}\n`)

function out(v) {
  if (wantJson) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); return }
  process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v, null, 2) + '\n')
}

function human(video) {
  const bits = [
    (video.sizeMB ?? '?') + 'MB',
    video.durationHuman || (video.duration ? video.duration + 's' : '?'),
    video.width ? `${video.width}x${video.height}` : '',
    video.aspect === 'portrait' ? '竖屏' : video.aspect === 'landscape' ? '横屏' : '',
    video.hasAudio ? '有声' : '无声',
    video.hasSubtitle ? '有字幕' : '',
    video.error ? `⚠︎ ${video.error}` : '',
  ].filter(Boolean)
  return `${video.name}  ${bits.join(' · ')}`
}

async function main() {
  const cfg = loadConfig()

  if (cmd === 'status') {
    const ffmpeg = resolveFfmpeg(cfg, 'ffmpeg')
    const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
    const local = localStatus(cfg)
    const api = apiStatus(cfg)
    const { key, from } = readSecretKey(cfg)
    const report = {
      home: HOME_DIR,
      dir: cfg.dir || '(没设)',
      ffmpeg: ffmpeg.path ? `${ffmpeg.path} (${ffmpeg.version || '?'})` : `✗ ${ffmpeg.hint}`,
      ffprobe: ffprobe.path ? `${ffprobe.path} (${ffprobe.version || '?'})` : `✗ ${ffprobe.hint}`,
      backend: cfg.backend,
      local: local.ready ? `✓ ${local.python}` : `✗ ${local.reason}`,
      api: api.ready ? `✓ ${api.endpoint}（key ${maskKey(key)} from ${from}）` : `✗ ${api.reason}`,
      install: installState(),
      log: INSTALL_LOG,
    }
    if (wantJson) return out(report)
    const lines = [
      `家目录      ${report.home}`,
      `默认目录    ${report.dir}`,
      `ffmpeg      ${report.ffmpeg}`,
      `ffprobe     ${report.ffprobe}`,
      `转写后端    ${report.backend}`,
      `本地引擎    ${report.local}`,
      `云端接口    ${report.api}`,
      `安装状态    running=${!!report.install.running} ok=${!!report.install.ok} step=${report.install.step || 'idle'}`,
      `安装日志    ${report.log}`,
    ]
    if (flag('verbose')) {
      const env = envReport(cfg)
      lines.push('', 'Python 探测：', ...(env.python.tried || []).map((t) => `  ${t}`))
      lines.push('', '安装日志尾巴：', installLogTail(20))
    }
    return out(lines.join('\n'))
  }

  if (cmd === 'scan') {
    const dir = positional[0] || cfg.dir
    if (!dir) return out('用法：node tools/cli.mjs scan <目录>')
    if (!existsSync(dir)) return out(`目录不存在：${dir}`)
    if (!statSync(dir).isDirectory()) {
      const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
      const m = probeVideo(ffprobe.path, dir)
      return out(wantJson ? m : human(m))
    }
    const res = scanDir(dir, { recursive: flag('recursive'), maxVideos: Number(val('limit', '40')) || 40 })
    if (!res.ok) return out(res.error)
    const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
    const rows = []
    for (const v of res.videos) {
      const m = ffprobe.path ? probeVideo(ffprobe.path, v.path) : { ok: false, error: '没有 ffprobe' }
      rows.push(m.ok ? { ...v, ...m } : { ...v, error: m.error })
    }
    if (wantJson) return out({ dir, count: rows.length, videos: rows })
    return out(`${dir}\n共 ${rows.length} 条：\n` + rows.map((r, i) => `  ${i + 1}. ${human(r)}`).join('\n'))
  }

  if (cmd === 'distill') {
    const file = positional[0]
    if (!file) return out('用法：node tools/cli.mjs distill <视频路径> [--force]')
    if (!existsSync(file)) return out(`文件不存在：${file}`)
    const b = await distillOne(cfg, {
      file,
      force: flag('force'),
      frames: Number(val('frames', String(cfg.frames))) || cfg.frames,
      backend: val('backend', cfg.backend),
      language: val('language', cfg.language),
      log,
    })
    if (wantJson) return out(b)
    if (!b.ok) return out(`✗ ${b.error}`)
    const c = compactBundle(b)
    const t = c.transcript
    const lines = [
      `✓ ${c.video.name}`,
      `  ${c.meta.durationHuman} · ${c.meta.width}x${c.meta.height} · ${c.meta.fps}fps · ${c.meta.aspect} · ${c.meta.hasAudio ? '有声' : '无声'}`,
      t.ok ? `  口播 ${t.charCount} 字（${t.backend}${t.note ? '·' + t.note : ''}，约 ${t.charsPerSec} 字/秒）` : `  ✗ 口播没拿到：${t.reason}`,
      `  关键帧 ${c.frames.length} 张${c.sheet ? ` + 拼图 ${c.sheet.path}` : ''}`,
      `  镜头切点 ${c.cuts.count} 个`,
      `  工作目录 ${c.workDir}`,
    ]
    if (!t.ok && t.how_to_fix) lines.push(`  修法：${t.how_to_fix}`)
    if (t.ok) {
      lines.push('', '  口播前 300 字：', '  ' + String(t.text).slice(0, 300).replace(/\n/g, '\n  '))
    }
    return out(lines.join('\n'))
  }

  if (cmd === 'guide') {
    const g = guideText()
    if (!g.ok) return out(g.error)
    const text = g.text
    if (wantJson) return out(g)
    return out(text)
  }

  if (cmd === 'asr-install') {
    const r = startInstall(cfg, { model: val('model', cfg.modelSize), downloadModel: !flag('no-model') })
    log(JSON.stringify(r, null, 2))
    if (!flag('wait')) return out(`后台在装了，日志：${INSTALL_LOG}\n看进度：node tools/cli.mjs status --verbose`)
    // --wait：盯着 state 直到 running=false（最长 20 分钟）
    const t0 = Date.now()
    let last = ''
    while (Date.now() - t0 < 20 * 60_000) {
      await new Promise((r2) => setTimeout(r2, 3000))
      const st = installState()
      if (st.step !== last) { last = st.step; log(`[${st.step}] ${st.error || ''}`) }
      if (!st.running) {
        return out(st.ok ? `✓ 装好了（${st.step}）` : `✗ 失败（${st.step}）：${st.error}`)
      }
    }
    return out('超时了，看日志：' + INSTALL_LOG)
  }

  out(`不认识的命令：${cmd}\n可用：status | scan | distill | guide | asr-install`)
}

main().catch((e) => {
  process.stderr.write(`崩了：${e?.stack ?? e}\n`)
  process.exit(1)
})
