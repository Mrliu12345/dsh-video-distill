/**
 * lib/env.mjs —— 这台机器上的「外部世界」：家目录、配置、ffmpeg、Python
 * ============================================================================
 * 设计上的三条硬约束（踩过的坑都写在这里，别再改回去）：
 *
 * ① **插件包目录只读**。配置、转写缓存、成稿全在 `$DSH_HOME/video-distill/` 下，
 *    绝不往 node_modules 里写（升级/重装会把它们全冲掉）。
 *
 * ② **不 import 任何第三方包**。这个插件 `dependencies` 是空的：
 *    profile 树里到底有没有 `@deepseek-ai/*` 是不确定的（桌面版 profile
 *    `autoInstallPeers:false`，经常一个都没有），一旦裸 import 失败，
 *    整条插件 fiber 都建不起来 —— 工具一个都注册不上，而且只在日志里留一句 warning。
 *    所以这里只用 `node:*` 内置模块，工具注册的那一点点胶水见 lib/toolkit.mjs。
 *
 * ③ **外部程序一律「先探再用」**。ffmpeg / python 找不到的时候要能说清
 *    「缺什么、去哪装、装完怎么回来验」，而不是抛一个 ENOENT 让模型去猜。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包目录（本文件在 lib/ 下，往上一层） */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** DSH 家目录：宿主会注入 DSH_HOME；没有就退回 ~/.dsh（跟 dsh 自己的默认一致） */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 插件自己的家：`<DSH_HOME>/video-distill/` */
export const HOME_DIR = join(DSH_HOME, 'video-distill')

export const WORK_DIR = join(HOME_DIR, 'work')
export const OUT_DIR = join(HOME_DIR, 'out')
export const MODEL_DIR = join(HOME_DIR, 'models')
export const BIN_DIR = join(HOME_DIR, 'bin')
export const LOG_DIR = join(HOME_DIR, 'logs')
export const VENV_DIR = join(HOME_DIR, '.venv')
export const CONFIG_FILE = join(HOME_DIR, 'config.json')
export const SECRET_FILE = join(HOME_DIR, 'secret.json')
export const INSTALL_LOG = join(LOG_DIR, 'asr-install.log')
export const RUNTIME_LOG = join(LOG_DIR, 'runtime.log')

export function ensureDirs() {
  for (const d of [HOME_DIR, WORK_DIR, OUT_DIR, MODEL_DIR, BIN_DIR, LOG_DIR]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 建不动也不致命，后面会报具体错误 */ }
  }
}

/** venv 里的 python 路径（Win / *nix 两套布局） */
export function venvPython() {
  const win = join(VENV_DIR, 'Scripts', 'python.exe')
  const nix = join(VENV_DIR, 'bin', 'python')
  return existsSync(win) ? win : existsSync(nix) ? nix : win
}

/**
 * venv 里到底有没有 faster-whisper —— **不能只看 venv 目录在不在**。
 * 🔴 踩过的坑：venv 是 pip 安装第一步就建出来的，那一刻"引擎就绪"是假的；
 *    真实测一次 import 才算数。进程启动一次约 1–2 秒，所以按 venv python 的
 *    mtime 缓存 2 分钟（重装会改 mtime，自动失效）。
 */
let vendorCache = { at: 0, key: '', value: null }
export function venvVendor() {
  const py = venvPython()
  if (!existsSync(py)) return { ready: false, python: '', reason: 'venv 还没建' }
  let mt = 0
  try { mt = statSync(py).mtimeMs } catch { mt = 0 }
  const key = `${py}|${mt}`
  if (vendorCache.value && vendorCache.key === key && Date.now() - vendorCache.at < 120_000) return vendorCache.value
  const r = probe(py, ['-c', 'import faster_whisper;print(getattr(faster_whisper,"__version__","?"))'], { timeout: 60_000 })
  const value = r.ok
    ? { ready: true, python: py, version: String(r.out).trim().split(/\r?\n/).pop() || '?' }
    : { ready: false, python: py, error: (r.err || r.out || '').slice(0, 300) }
  vendorCache = { at: Date.now(), key, value }
  return value
}

/** 装完/重装完要立刻作废缓存，否则最长 2 分钟内还在说"没装" */
export function clearVendorCache() {
  vendorCache = { at: 0, key: '', value: null }
}

/* ─────────────────────────── 视频扩展名 ─────────────────────────── */

export const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.flv', '.webm', '.wmv', '.ts', '.mts', '.mpg', '.mpeg', '.3gp',
])

export const isVideo = (p) => VIDEO_EXT.has(String(p).slice(String(p).lastIndexOf('.')).toLowerCase())

/* ─────────────────────────── 配置 ─────────────────────────── */

/**
 * 全部配置项的默认值。**改这里就等于改默认行为**，config.json 只存覆盖项。
 * 说明都写在这个对象里，`video_config action=defaults` 会原样吐给使用者看。
 */
export const DEFAULTS = {
  /** 默认视频目录（使用者说「那个目录」之前就是它；留空 = 每次调用必须传 dir） */
  dir: '',
  /** 成稿目录（留空 = `$DSH_HOME/video-distill/out`） */
  outDir: '',
  /**
   * 转写后端：auto | sidecar | embedded | local | api | none
   *   auto     依次试：同名字幕 → 内嵌字幕 → 本地 faster-whisper → 兼容 OpenAI 的 API
   *   sidecar  只认同名 .srt/.vtt/.ass/.json（最快，零依赖）
   *   embedded 只认容器里内嵌的字幕流
   *   local    本地 faster-whisper（要 `video_asr_install` 装一次）
   *   api      调 `apiBaseUrl` 的 `/audio/transcriptions`
   */
  backend: 'auto',
  /** 转写语言：zh / en / ja …；`auto` = 让模型自己判定 */
  language: 'zh',
  /** 本地模型档位：tiny / base / small / medium / large-v3（中文口播 small 起步） */
  modelSize: 'small',
  /** 每个视频抽几张关键帧（1–16） */
  frames: 6,
  /** 抽关键帧时是否检测镜头切点（能看出节奏，慢一点） */
  sceneDetect: true,
  /**
   * 切点阈值：scene 分超过它就记一次换镜（0–1）。
   * 0.3 是实测的平衡点：真人口播里换镜基本都 >0.4；纯色/慢推镜可能只有 0.2。
   * 觉得"切点数明显偏少/偏多"就调它（0.2 更敏感，0.45 更保守）。
   */
  sceneThreshold: 0.3,
  /** 一次最多扫多少个视频（防止误扫整个盘） */
  maxVideos: 20,
  /** 小于这个时长（秒）的当垃圾跳过 */
  minSec: 3,
  /** 大于这个时长（秒）的跳过（默认 30 分钟） */
  maxSec: 1800,
  /** ffmpeg / ffprobe 绝对路径（留空 = 先在 PATH 里找，再找几个常见安装位置） */
  ffmpegPath: '',
  ffprobePath: '',
  /** 建 venv 用的 python（留空 = 自动挑一个 ≥3.9 的） */
  pythonPath: '',
  /** 兼容 OpenAI 的转写接口根地址，例：https://api.siliconflow.cn/v1 */
  apiBaseUrl: '',
  /** 语音转写模型名，例：FunAudioLLM/SenseVoiceSmall、whisper-1 */
  apiModel: 'whisper-1',
  /** API Key 从哪个环境变量读（真正的 key 存 secret.json，见 readSecret） */
  apiKeyEnv: 'DSH_ASR_KEY',
  /** 下 HuggingFace 模型的镜像（国内直连不通，默认走 hf-mirror） */
  hfMirror: 'https://hf-mirror.com',
  /** pip 镜像（按顺序试） */
  pipMirrors: [
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.aliyun.com/pypi/simple',
    'https://pypi.org/simple',
  ],
  /** 转写完是否保留 16k 单声道 wav（默认删掉，只留文本） */
  keepAudio: false,
  /** 单条视频转写超时（秒） */
  asrTimeoutSec: 1800,
}

/** 读 config.json（坏文件也不抛，返回 {}) */
export function readConfigFile() {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

/** 合并后的配置（默认 ← config.json） */
export function loadConfig() {
  const file = readConfigFile()
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (file[k] !== undefined && file[k] !== null && file[k] !== '') out[k] = file[k]
  }
  return out
}

/** 写回 config.json（只写非默认项，文件保持短小好读） */
export function writeConfig(patch) {
  const file = readConfigFile()
  const next = { ...file }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === '' || v === null || v === undefined) delete next[k]
    else next[k] = v
  }
  ensureDirs()
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return loadConfig()
}

/**
 * 语音接口的 Key：**永远不进 config.json**（config 会被日志、被工具返回值带出去）。
 * 顺序：环境变量 → `$DSH_HOME/video-distill/secret.json` 的 `asrKey`。
 */
export function readSecretKey(cfg) {
  const envName = String(cfg?.apiKeyEnv || 'DSH_ASR_KEY')
  if (process.env[envName]) return { key: String(process.env[envName]), from: `env:${envName}` }
  try {
    const j = JSON.parse(readFileSync(SECRET_FILE, 'utf8'))
    if (j && typeof j.asrKey === 'string' && j.asrKey.trim()) return { key: j.asrKey.trim(), from: 'secret.json' }
  } catch { /* 没有就算了 */ }
  return { key: '', from: '' }
}

export function writeSecretKey(key) {
  ensureDirs()
  const j = {}
  try { Object.assign(j, JSON.parse(readFileSync(SECRET_FILE, 'utf8'))) } catch { /* 新建 */ }
  if (key) j.asrKey = String(key)
  else delete j.asrKey
  writeFileSync(SECRET_FILE, JSON.stringify(j, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return !!key
}

/** 打码：只留尾巴，日志里永远不出现完整 key */
export const maskKey = (k) => {
  const s = String(k || '')
  if (!s) return ''
  return s.length <= 8 ? '***' : `${s.slice(0, 3)}***${s.slice(-4)}`
}

/* ─────────────────────────── 外部程序探测 ─────────────────────────── */

/** 跑一下 `cmd args`，只关心能不能起来 + 前几行输出 */
export function probe(cmd, args = ['-version'], { timeout = 8000 } = {}) {
  if (!cmd) return { ok: false, out: '', err: 'empty command' }
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true })
    const out = String(r.stdout || '') + String(r.stderr || '')
    if (r.error) return { ok: false, out, err: String(r.error.message || r.error) }
    return { ok: r.status === 0, out, err: r.status === 0 ? '' : `exit ${r.status}` }
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e) }
  }
}

const whichCache = new Map()

function which(name) {
  if (whichCache.has(name)) return whichCache.get(name)
  let found = ''
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 6000, windowsHide: true })
    const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (r.status === 0 && first && existsSync(first)) found = first
  } catch { /* 没有就没有 */ }
  whichCache.set(name, found)
  return found
}

/**
 * 找 ffmpeg / ffprobe。
 * 顺序：配置写死的 → PATH → 几个常见安装位置（本机就是 D:\Resources\ffmpeg\…）。
 * 返回 `{ path, source, version }`；找不到时 `path=''`，并且 `hint` 直接能念给使用者听。
 */
export function resolveFfmpeg(cfg, kind = 'ffmpeg') {
  const want = kind === 'ffprobe' ? 'ffprobe' : 'ffmpeg'
  const configured = String((kind === 'ffprobe' ? cfg?.ffprobePath : cfg?.ffmpegPath) || '').trim()
  const candidates = []
  const push = (p, source) => { if (p && !candidates.some((c) => c.path === p)) candidates.push({ path: p, source }) }
  push(configured, 'config')
  push(which(want), 'PATH')
  if (process.platform === 'win32') {
    const exe = `${want}.exe`
    for (const root of [
      'D:\\Resources\\ffmpeg', 'C:\\ffmpeg', 'D:\\ffmpeg', 'C:\\Program Files\\ffmpeg',
      join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
    ]) {
      if (!root || !existsSync(root)) continue
      for (const p of shallowFind(root, exe, 3)) push(p, 'common-path')
    }
  } else {
    for (const p of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((d) => join(d, want))) push(p, 'common-path')
  }
  for (const c of candidates) {
    if (!existsSync(c.path)) continue
    const r = probe(c.path, ['-version'])
    if (r.ok) {
      const version = (r.out.match(/version\s+(\S+)/i) || [])[1] || ''
      return { path: c.path, source: c.source, version, hint: '' }
    }
  }
  return {
    path: '',
    source: '',
    version: '',
    hint: `没找到 ${want}。装一个再回来：winget install Gyan.FFmpeg（或把 ffmpeg.exe 所在目录加进 PATH），`
      + `也可以在 config.json 里写 "${kind === 'ffprobe' ? 'ffprobePath' : 'ffmpegPath'}" 指到具体的 exe。`,
  }
}

/** 浅浅地找某个文件名（最多 depth 层），用于「装在 D:\Resources\ffmpeg\ffmpeg-x.y\bin」这种布局 */
function shallowFind(root, name, depth) {
  const out = []
  const walk = (dir, left) => {
    if (left < 0 || out.length > 8) return
    let entries = []
    // 有些目录（System Volume Information 之类）会抛 EPERM，单独兜住
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, left - 1)
      else if (e.name.toLowerCase() === name.toLowerCase()) out.push(p)
    }
  }
  walk(root, depth)
  return out
}

/* ─────────────────────────── Python ─────────────────────────── */

/** 跑 `py -0p` / 直接问版本，挑出 ≥3.9 的解释器（faster-whisper 要求） */
export function findPython(cfg, { minMajor = 3, minMinor = 9 } = {}) {
  const tried = []
  const check = (cmd, args = []) => {
    const v = spawnSync(cmd, [...args, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    })
    const ver = String(v.stdout || '').trim()
    const m = ver.match(/^(\d+)\.(\d+)$/)
    const ok = !v.error && v.status === 0 && m && (Number(m[1]) > minMajor || (Number(m[1]) === minMajor && Number(m[2]) >= minMinor))
    tried.push(`${cmd} ${args.join(' ')} → ${ok ? ver : (ver || 'n/a')}`)
    return ok ? { cmd, args, version: ver } : null
  }
  const configured = String(cfg?.pythonPath || '').trim()
  if (configured) {
    const hit = check(configured)
    if (hit) return { ...hit, source: 'config', tried }
  }
  const vp = venvPython()
  if (existsSync(vp)) {
    const hit = check(vp)
    if (hit) return { ...hit, source: 'venv', tried }
  }
  for (const [cmd, args] of [
    ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['py', ['-3.9']],
    [which('python'), []], [which('python3'), []],
  ]) {
    if (!cmd) continue
    const hit = check(cmd, args)
    if (hit) return { ...hit, source: 'auto', tried }
  }
  return { cmd: '', args: [], version: '', source: '', tried }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

export const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 目录名里不能出现的字符 → `_`；顺便截断，防止超长路径 */
export function safeName(s, max = 60) {
  const t = String(s || 'untitled')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return (t || 'untitled').slice(0, max)
}

/** 路径是不是在某个目录里面（防止 outDir 瞎指到系统目录时误删） */
export function insideOf(child, parent) {
  const a = resolve(child) + sep
  const b = resolve(parent) + sep
  return a.startsWith(b)
}
