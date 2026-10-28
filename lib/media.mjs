/**
 * lib/media.mjs —— 把视频"拆开来看"：元数据 / 音轨 / 关键帧 / 镜头切点
 * ============================================================================
 * 这里只做**确定性的、看得见的**事：ffprobe 读元数据，ffmpeg 抽音轨和帧。
 * 「理解」视频内容不在这里 —— 那是模型拿转写文本 + 关键帧去做的（见 prompts/distill.md）。
 *
 * 几条实测过的讲究：
 *   * 抽帧用 **每帧一次 seek**（`-ss` 在 `-i` 之前）：比解码全片快一到两个数量级，
 *     差几百毫秒无所谓 —— 关键帧是给模型看构图和字幕的，不是做精确剪辑。
 *   * `-q:v 3` + 宽 720：一帧 60–120KB，6 帧也就半兆，模型看得清又不烧 token。
 *   * 帧名用 `frame-01.jpg`（image2 认这种连续编号），contact sheet 才能一把 tile 完。
 *   * 镜头切点用 `select='gt(scene,0.3)'` + `showinfo`，从 stderr 里捞 `pts_time:`；
 *     切点多 = 节奏碎（口播+快剪），切点少 = 长镜头（剧情/一镜到底）。
 * ============================================================================
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { isVideo } from './env.mjs'

/** 跑一个外部命令，永不抛；返回 {status, stdout, stderr} */
export function run(cmd, args, { timeout = 120_000, cwd = undefined, env = null } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    })
    return {
      status: r.status ?? -1,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
      error: r.error ? String(r.error.message || r.error) : '',
    }
  } catch (e) {
    return { status: -1, stdout: '', stderr: '', error: String(e?.message ?? e) }
  }
}

/* ─────────────────────────── 目录扫描 ─────────────────────────── */

/**
 * 扫目录里的视频（默认只扫一层；`recursive` 才往下走）。
 * 不 probe —— 只给清单，probe 由调用方按需做（一目录几十个片子时，全 probe 太慢）。
 */
export function scanDir(dir, { recursive = false, maxVideos = 20, minSec = 0, maxSec = 0 } = {}) {
  const out = []
  const walk = (d, depth) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch (e) {
      return { error: `目录读不了：${e?.message ?? e}` }
    }
    for (const e of entries) {
      if (out.length >= maxVideos) return null
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (recursive && depth < 3) walk(p, depth + 1)
        continue
      }
      if (!isVideo(e.name)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile() || st.size < 1024) continue
      out.push({
        path: p,
        name: basename(p),
        sizeMB: Math.round((st.size / 1048576) * 10) / 10,
        mtime: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
      })
    }
    return null
  }
  const fail = walk(dir, 0)
  if (fail?.error) return { ok: false, error: fail.error, videos: [] }
  // 目录里没视频但有子目录 ⇒ 多半是想扫一整棵，提示一下
  return { ok: true, videos: out, truncated: out.length >= maxVideos, minSec, maxSec }
}

/* ─────────────────────────── ffprobe ─────────────────────────── */

/** 打分数字符串："30000/1001" → 29.97 */
function parseRate(s) {
  const m = String(s || '').match(/^(\d+)\/(\d+)$/)
  if (!m) return Number(s) || 0
  const a = Number(m[1]), b = Number(m[2])
  return b ? Math.round((a / b) * 100) / 100 : 0
}

/**
 * 读一个视频的元数据。
 * 返回的字段都是"模型真会用到的"：时长、分辨率、码率、有没有声音、有没有内嵌字幕。
 */
export function probeVideo(ffprobe, file) {
  const r = run(ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ], { timeout: 30_000 })
  if (r.status !== 0) {
    return { ok: false, error: `ffprobe 失败：${(r.stderr || r.error || '').slice(0, 300)}` }
  }
  let j
  try { j = JSON.parse(r.stdout) } catch { return { ok: false, error: 'ffprobe 输出不是 JSON' } }

  const streams = Array.isArray(j.streams) ? j.streams : []
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const a = streams.find((s) => s.codec_type === 'audio')
  const subs = streams.filter((s) => s.codec_type === 'subtitle')
  const fmt = j.format || {}
  const duration = Number(fmt.duration || v?.duration || 0) || 0

  return {
    ok: true,
    file,
    name: basename(file),
    duration: Math.round(duration * 100) / 100,
    durationHuman: humanDuration(duration),
    sizeMB: Math.round((Number(fmt.size || 0) / 1048576) * 10) / 10,
    bitrateKbps: Math.round(Number(fmt.bit_rate || 0) / 1000) || 0,
    format: String(fmt.format_name || ''),
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    fps: parseRate(v?.r_frame_rate || v?.avg_frame_rate),
    videoCodec: String(v?.codec_name || ''),
    pixFmt: String(v?.pix_fmt || ''),
    hasVideo: !!v,
    hasAudio: !!a,
    audioCodec: String(a?.codec_name || ''),
    audioChannels: Number(a?.channels) || 0,
    audioSampleRate: Number(a?.sample_rate) || 0,
    subtitleStreams: subs.map((s, i) => ({ index: s.index, order: i, codec: s.codec_name, lang: s.tags?.language || '' })),
    /** 竖屏/横屏/方形 —— 直接决定"这是短视频还是长视频"的判断 */
    aspect: !v ? 'unknown' : (Number(v.height) > Number(v.width) ? 'portrait' : Number(v.height) === Number(v.width) ? 'square' : 'landscape'),
    tags: fmt.tags || {},
  }
}

export function humanDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60), r = s % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

/* ─────────────────────────── 音轨 ─────────────────────────── */

/** 抽 16k 单声道 wav（faster-whisper / 各家 ASR 都吃这个） */
export function extractAudio(ffmpeg, file, outWav) {
  mkdirSync(join(outWav, '..'), { recursive: true })
  const r = run(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', file,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav,
  ], { timeout: 300_000 })
  if (r.status !== 0) return { ok: false, error: `抽音轨失败：${(r.stderr || r.error).slice(0, 300)}` }
  try {
    const size = statSync(outWav).size
    if (size < 44) return { ok: false, error: '抽出来的音轨是空的（这个视频可能没有声音）' }
    return { ok: true, path: outWav, size }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/* ─────────────────────────── 关键帧 ─────────────────────────── */

/**
 * 均匀取 N 个时间点，避开片头片尾（片头常有黑场/logo，片尾常有二维码）。
 * 3 秒以内的短片直接取中间一帧。
 */
export function pickTimes(duration, n) {
  const d = Number(duration) || 0
  const count = Math.max(1, Math.min(16, Math.round(Number(n) || 6)))
  if (d <= 3) return [Math.max(0, d / 2)]
  const start = d * 0.05
  const end = d * 0.95
  const span = end - start
  const out = []
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? start + span / 2 : start + (span * i) / (count - 1)
    out.push(Math.round(t * 100) / 100)
  }
  return out
}

/** 抽帧。返回 [{ t, path, index }] */
export function extractFrames(ffmpeg, file, framesDir, times, { width = 720 } = {}) {
  mkdirSync(framesDir, { recursive: true })
  const got = []
  times.forEach((t, i) => {
    const name = `frame-${String(i + 1).padStart(2, '0')}.jpg`
    const out = join(framesDir, name)
    const r = run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-ss', String(t), '-i', file,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', out,
    ], { timeout: 60_000 })
    if (r.status === 0) {
      try { if (statSync(out).size > 512) got.push({ t, index: i + 1, path: out }) } catch { /* 坏了就跳过 */ }
    }
  })
  return got
}

/**
 * 拼一张 contact sheet（一眼看完 N 帧，省 N 次看图）。
 * 行优先：左→右、上→下 就是时间顺序；帧序号与 t 的对应见 bundle.frames。
 */
export function contactSheet(ffmpeg, frames, sheetPath) {
  if (!frames.length) return { ok: false, error: '没有帧可拼' }
  const n = frames.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  mkdirSync(join(sheetPath, '..'), { recursive: true })
  const r = run(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-framerate', '1', '-i', join(frames[0].path.replace(/frame-\d+\.jpg$/, ''), 'frame-%02d.jpg'),
    '-vf', `tile=${cols}x${rows}:padding=8:margin=8:color=0x202020`,
    '-frames:v', '1', '-q:v', '3', sheetPath,
  ], { timeout: 120_000 })
  if (r.status !== 0) return { ok: false, error: `拼图失败：${(r.stderr || r.error).slice(0, 200)}` }
  return { ok: true, path: sheetPath, cols, rows }
}

/* ─────────────────────────── 镜头切点 ─────────────────────────── */

/**
 * 切点检测：`scene` 分 > 0.3 的帧就是一次"换镜"。
 * 只在**降分辨率**后的画面上算（scale=320:-2），否则 1080p 逐帧算 scene 会慢到离谱。
 */
export function detectCuts(ffmpeg, file, { threshold = 0.3, timeout = 180_000 } = {}) {
  const r = run(ffmpeg, [
    '-hide_banner', '-loglevel', 'info', '-i', file,
    '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ], { timeout })
  if (r.status !== 0) return { ok: false, error: `切点检测失败：${(r.stderr || r.error).slice(0, 200)}`, cuts: [] }
  const cuts = []
  const re = /pts_time:([0-9.]+)/g
  let m
  while ((m = re.exec(r.stderr))) {
    const t = Math.round(Number(m[1]) * 100) / 100
    if (Number.isFinite(t)) cuts.push(t)
  }
  return { ok: true, cuts, count: cuts.length }
}

/** 清一个工作目录（force 重做时用） */
export function wipe(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉就算了，后面会覆盖 */ }
}

/** 目录里的文件数（做健康检查时用） */
export function countFiles(dir) {
  try { return readdirSync(dir).length } catch { return 0 }
}

export const extOf = (p) => extname(String(p || '')).toLowerCase()
