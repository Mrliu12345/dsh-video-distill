#!/usr/bin/env node
/**
 * tools/e2e.mjs —— 端到端演练：用**假 ctx 真调工具**，把整条链路跑一遍
 * ============================================================================
 * selftest.mjs 验的是"装配对不对"（工具注册、schema、依赖洁癖）。
 * 这里验的是"活干不干得成"：scan → distill → guide → save，全走工具的 execute()。
 *
 * 用法：
 *   node tools/e2e.mjs                       # 用 tools/make-test-media.ps1 造的测试素材目录
 *   node tools/e2e.mjs D:\videos\某目录       # 换成自己的目录
 *   node tools/e2e.mjs D:\某视频.mp4 --frames 4
 *
 * 退出码 0 = 全通；1 = 有步骤失败（失败原因会打出来）。
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--')) || join(tmpdir(), 'video-distill-test')
const framesIdx = args.indexOf('--frames')
const frames = framesIdx >= 0 ? Number(args[framesIdx + 1]) || 6 : 6

const registered = new Map()
const ctx = {
  tools: { register: (t) => { registered.set(t.name, t); return t } },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
}
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
mod.apply(ctx)
const call = async (name, a = {}) => {
  const t = registered.get(name)
  if (!t) throw new Error(`没注册 ${name}`)
  return t.execute(a, {})
}

let step = 0
const okLog = (m) => console.log(`${++step}. ${m}`)
const bad = (m) => { console.log(`✗ ${m}`); process.exitCode = 1 }

if (!existsSync(target)) {
  bad(`目标不存在：${target}（先跑 tools/make-test-media.ps1 造素材）`)
  process.exit(1)
}

/* 1. 体检 */
const st = await call('video_status')
okLog(`video_status：ffmpeg=${st.ffmpeg.path ? '✓' : '✗'} 本地引擎=${st.asr.local.ready ? '✓' : '✗'} API=${st.asr.api.ready ? '✓' : '✗'}`)
if (!st.ffmpeg.path) { bad('没有 ffmpeg，后面的步骤没法跑'); process.exit(1) }

/* 2. 扫 */
const scan = await call('video_scan', { dir: target, limit: 10 })
okLog(`video_scan：${scan.ok ? `✓ ${scan.count} 条` : `✗ ${scan.error}`}`)
if (!scan.ok) { bad('扫目录失败'); process.exit(1) }
for (const v of scan.videos) console.log(`     · ${v.name} ${v.durationHuman || ''} ${v.aspect || ''} ${v.hasAudio ? '有声' : '无声'}${v.hasSubtitle ? ' 有字幕' : ''}`)

/* 3. 蒸第一条有口播/有字幕的 */
const pick = scan.videos.find((v) => v.hasSubtitle || v.hasAudio) || scan.videos[0]
if (!pick) { bad('目录里没有视频'); process.exit(1) }
const d = await call('video_distill', { video: pick.path, frames })
if (!d.ok) { bad(`video_distill 失败：${d.error}`); process.exit(1) }
okLog(`video_distill：✓ ${d.video.name}｜口播 ${d.transcript.ok ? `${d.transcript.charCount} 字（${d.transcript.backend}）` : `没拿到（${d.transcript.reason}）`}｜帧 ${d.frames.length} 张｜切点 ${d.cuts.count} 个`)
console.log(`     sheet=${d.sheet?.path || '(无)'}`)
console.log(`     briefing=${String(d.briefing).slice(0, 120)}…`)

/* 4. 手册 */
const g = await call('video_guide')
okLog(`video_guide：${g.ok ? `✓ ${g.text.length} 字` : `✗ ${g.error}`}`)

/* 5. 存成稿 */
const sample = [
  '# 演练用拆解（e2e 自动生成，可以删）',
  '',
  '## 一句话卖点',
  `《${d.video.name}》这条片子把"结论先给"讲成了一个可执行的动作。`,
  '',
  '## 结构骨架',
  '- 钩子（0–3s）：先否定一个普遍做法',
  '- 中段：给出替代动作',
  '- 落点：一句反问收尾',
  '',
  '## 生成的同款文案（A 条）',
  '别再花两小时调色了，先花十分钟写第一句。',
].join('\n')
const saved = await call('video_save', { title: 'e2e-演练', content: sample, kind: 'analysis', source: d.video.name })
if (!saved.ok) bad(`video_save 失败：${saved.error}`)
else okLog(`video_save：✓ ${saved.path}`)

/* 6. 缓存命中 */
const again = await call('video_distill', { video: pick.path, frames })
okLog(`再蒸一次：${again.cached ? '✓ 命中缓存（没重复跑转写）' : '· 没命中缓存（首次转写失败时不缓存，属正常）'}`)

console.log(process.exitCode ? '\n有步骤失败' : '\n端到端全通 ✓')
