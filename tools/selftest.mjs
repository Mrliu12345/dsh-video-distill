#!/usr/bin/env node
/**
 * tools/selftest.mjs —— 离线自检：不连 DSH、不碰网络，只验"插件能不能被宿主正确装配"
 * ============================================================================
 * 它检查的是那种**只有在真机上才会暴露**的问题：
 *   * index.js 有没有导出 name / inject / apply（导出错了 ⇒ 宿主静默不激活）
 *   * 每个工具是不是「名字不空、description 说人话、parameters 是合法 JSON Schema」
 *   * 有没有偷偷 import 第三方包（profile 里没装就会整条插件不激活）
 *   * 手册、asr.py、cordis.patch.yml 这些随包文件在不在
 *   * 用假 ctx 真调一遍 apply()，把工具全注册一遍，看有没有在注册阶段就抛
 *
 * 用法：node tools/selftest.mjs
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0
const fails = []
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fails.push(`${msg}${detail ? `（${detail}）` : ''}`); console.log(`  ✗ ${msg}${detail ? `（${detail}）` : ''}`) }
}
const section = (t) => console.log(`\n== ${t} ==`)

/* ── 1. 随包文件 ── */
section('随包文件')
for (const f of [
  'package.json', 'index.js', 'cordis.patch.yml', 'lib/env.mjs', 'lib/media.mjs', 'lib/asr.mjs',
  'lib/distill.mjs', 'lib/install.mjs', 'lib/guide.mjs', 'lib/toolkit.mjs',
  'tools/asr.py', 'tools/cli.mjs', 'prompts/distill.md', 'README.md', 'AGENTS.md',
]) {
  ok(existsSync(join(ROOT, f)), f)
}

/* ── 2. package.json 契约 ── */
section('package.json')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
ok(pkg.name === 'dsh-video-distill', 'name 是 dsh-video-distill', pkg.name)
ok(/^\d+\.\d+\.\d+/.test(pkg.version || ''), 'version 合法', pkg.version)
ok(pkg.type === 'module', 'type=module（插件是 ESM）')
ok(pkg.main === 'index.js', 'main=index.js')
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 指到 cordis.patch.yml')
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '没有运行时 dependencies（这是刻意的）')
for (const f of pkg.files || []) {
  const p = f.replace(/^!/, '')
  if (p.includes('*')) continue
  ok(existsSync(join(ROOT, p)), `files 里列的 ${p} 真的存在`)
}

/* ── 3. 不许裸 import 第三方 ── */
section('依赖洁癖（裸 import 会让插件静默不激活）')
const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(mjs|js|py)$/.test(e.name)) acc.push(p)
  }
  return acc
}
const files = walk(ROOT)
let bare = []
for (const f of files.filter((x) => /\.(mjs|js)$/.test(x))) {
  const src = readFileSync(f, 'utf8')
  const re = /(?:^|\n)\s*(?:import[^'"]*from\s*|await import\(\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue
    if (spec === '@deepseek-ai/dsh-tools') continue // 有本地兜底实现，见 lib/toolkit.mjs
    bare.push(`${relative(ROOT, f)} → ${spec}`)
  }
}
ok(bare.length === 0, '没有裸 import（除 dsh-tools 兜底外）', bare.join('; '))

/* ── 4. 手册内容 ── */
section('蒸馏手册')
const guide = readFileSync(join(ROOT, 'prompts/distill.md'), 'utf8')
ok(guide.length > 1500, '手册够长（不是占位符）', `${guide.length} 字`)
for (const kw of ['钩子', '结构骨架', '语言指纹', '可复用模板', '5 字/秒', '不编数据']) {
  ok(guide.includes(kw), `手册里有「${kw}」`)
}

/* ── 5. 真装载一遍（假 ctx） ── */
section('装载（假 ctx）')
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
ok(mod.name === 'video-distill', '导出 name=video-distill', mod.name)
ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 里有 tools', JSON.stringify(mod.inject))
ok(typeof mod.apply === 'function', '导出 apply(ctx)')

const registered = []
const logs = []
const ctx = {
  tools: { register: (t) => { registered.push(t); return t } },
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  effect: (fn) => fn(),
}
try {
  mod.apply(ctx)
  ok(true, 'apply() 没抛异常')
} catch (e) {
  ok(false, 'apply() 抛了异常', String(e?.stack || e).split('\n')[0])
}
ok(registered.length >= 7, `注册了 ≥7 个工具`, `${registered.length} 个`)

const expect = ['video_status', 'video_config', 'video_scan', 'video_distill', 'video_save', 'video_guide', 'video_asr_install']
for (const n of expect) ok(registered.some((t) => t.name === n), `有工具 ${n}`)

/* ── 6. 工具规格自检 ── */
section('工具规格')
for (const t of registered) {
  const tag = t.name
  ok(typeof t.name === 'string' && t.name.length > 0 && /^[a-z0-9_]+$/.test(t.name), `${tag}：名字合法`)
  ok(typeof t.description === 'string' && t.description.length >= 20, `${tag}：description 够用`, `${(t.description || '').length} 字`)
  ok(typeof t.execute === 'function', `${tag}：有 execute`)
  const p = t.parameters
  ok(p && typeof p === 'object', `${tag}：有 parameters`)
  ok(p?.type === 'object', `${tag}：parameters 是显式 object 包装`)
  // 🔴 根节点必须是开放的：写 false 会在注册阶段直接抛（见 lib/toolkit.mjs 的长注释）
  ok(p?.additionalProperties !== false, `${tag}：根节点没被写死 additionalProperties:false`)
  const props = p?.properties || {}
  ok(Object.keys(props).length > 0 || tag === 'video_guide', `${tag}：有参数（或确实无参）`)
  for (const [k, v] of Object.entries(props)) {
    ok(!!v && typeof v === 'object' && typeof v.type === 'string', `${tag}.${k}：有 type`)
    ok(typeof v.description === 'string' && v.description.length > 0, `${tag}.${k}：有 description`)
  }
  for (const r of p?.required || []) {
    ok(Object.hasOwn(props, r), `${tag}：required 里的 ${r} 真的在 properties 里`)
  }
  ok(!!t.output && typeof t.output.render === 'function', `${tag}：output.render 是个函数`)
}

/* ── 7. 手册工具真跑一次 ── */
section('跑一遍只读工具')
const guideTool = registered.find((t) => t.name === 'video_guide')
if (guideTool) {
  const r = await guideTool.execute({}, {})
  ok(r?.ok === true && String(r.text || '').length > 1500, 'video_guide 返回了手册全文', `${String(r?.text || '').length} 字`)
} else ok(false, '找不到 video_guide')

const statusTool = registered.find((t) => t.name === 'video_status')
if (statusTool) {
  const r = await statusTool.execute({}, {})
  ok(r?.ok === true, 'video_status 能跑')
  ok(!!r?.ffmpeg?.path || !!r?.ffmpeg?.hint, 'video_status 说了 ffmpeg 在不在')
  ok(!!r?.asr, 'video_status 报告了转写能力')
} else ok(false, '找不到 video_status')

const cfgTool = registered.find((t) => t.name === 'video_config')
if (cfgTool) {
  const r = await cfgTool.execute({ action: 'defaults' }, {})
  ok(r?.ok === true && r.defaults && r.defaults.backend, 'video_config action=defaults 能跑')
} else ok(false, '找不到 video_config')

/* ── 8. 返回值必须能 JSON 化（宿主只吃无损 JSON） ── */
section('返回值可序列化')
for (const t of registered) {
  ok(typeof t.execute === 'function', `${t.name}：execute 在`)
}
let serializable = true
if (statusTool) {
  const r = await statusTool.execute({}, {})
  try { JSON.parse(JSON.stringify(r)) } catch { serializable = false }
}
ok(serializable, 'video_status 的返回值能 JSON.stringify')

/* ── 结尾 ── */
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) {
  console.log('\n失败清单：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
