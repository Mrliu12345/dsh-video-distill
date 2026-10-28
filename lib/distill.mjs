/**
 * lib/distill.mjs —— 一条视频的「蒸馏前处理」：把片子变成模型读得懂的一叠材料
 * ============================================================================
 * 产物（都在 `$DSH_HOME/video-distill/work/<名字>-<指纹>/` 里）：
 *
 *   meta.json        ffprobe 的干净元数据（时长/分辨率/帧率/有没有人声/有没有字幕流）
 *   transcript.json  转写结果（后端、语言、逐段起止时间、全文）
 *   transcript.md    **给人看的那份**：带 [mm:ss] 时间轴 + 语速，模型读这个最省事
 *   frames/*.jpg     关键帧（默认 6 张，720 宽）
 *   sheet.jpg        关键帧拼图（一次看完，省 N 次读图）
 *   bundle.json      上面所有的索引（下次直接命中缓存）
 *
 * 🔴 为什么要有缓存：一条 60 秒的口播，本地 small 模型要跑十几二十秒；
 *    模型问第二遍"再看一眼这个视频"的时候，不该再等一遍。
 *    指纹 = 绝对路径 + 大小 + mtime —— 视频被替换/重下过就自动失效。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { WORK_DIR, isVideo, readJson, resolveFfmpeg, safeName, writeJson } from './env.mjs'
import {
  contactSheet, detectCuts, extractAudio, extractFrames, humanDuration, pickTimes, probeVideo, wipe,
} from './media.mjs'
import { transcribe } from './asr.mjs'

/** 工作目录的名字：`名字-指纹8位`（名字给人看，指纹防碰撞） */
export function videoId(file, st) {
  const h = createHash('sha1')
    .update(`${file}|${st.size}|${st.mtimeMs}`)
    .digest('hex')
    .slice(0, 8)
  const stem = safeName(basename(file, extname(file)), 48)
  return `${stem}-${h}`
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 把转写结果写成「带时间轴的 md」——模型读这个，比读原始 JSON 省一半 token */
export function renderTranscriptMd(bundle) {
  const t = bundle.transcript || {}
  const m = bundle.meta || {}
  const lines = []
  lines.push(`# ${bundle.video.name}`)
  lines.push('')
  lines.push(`- 时长：${humanDuration(m.duration)}（${m.duration}s）`)
  lines.push(`- 画面：${m.width}×${m.height} · ${m.fps}fps · ${m.aspect === 'portrait' ? '竖屏' : m.aspect === 'square' ? '方形' : '横屏'} · ${m.videoCodec}`)
  lines.push(`- 声音：${m.hasAudio ? `${m.audioCodec} ${m.audioChannels} 声道` : '**没有音轨**'}`)
  if (t.ok) {
    const cs = t.charCount || 0
    const cps = t.charsPerSec ? ` · 约 ${t.charsPerSec} 字/秒` : ''
    lines.push(`- 转写：${t.backend}${t.note ? `（${t.note}）` : ''} · 语言 ${t.language || '?'} · ${cs} 字${cps}`)
  } else {
    lines.push(`- 转写：**没拿到**（${t.reason || '未知原因'}）`)
  }
  lines.push('')
  if (t.ok) {
    lines.push('## 口播时间轴')
    lines.push('')
    if (Array.isArray(t.segments) && t.segments.length) {
      for (const s of t.segments) lines.push(`[${clock(s.start)}] ${s.text}`)
    } else {
      lines.push(t.text)
    }
    lines.push('')
    lines.push('## 全文（可直接粘）')
    lines.push('')
    lines.push(t.text)
  } else if (t.how_to_fix) {
    lines.push('## 怎么办')
    lines.push('')
    lines.push(t.how_to_fix)
  }
  return lines.join('\n') + '\n'
}

/** 这次调用对模型说的话（每个视频/每种状态都说不一样的，不说套话） */
function briefingOf(bundle) {
  const t = bundle.transcript || {}
  const parts = []
  parts.push(`《${bundle.video.name}》材料已备好（工作目录：${bundle.workDir}）`)
  if (t.ok) {
    parts.push(`口播 ${t.charCount} 字已转好（${t.backend}），带时间轴的在 transcript.md。`)
  } else {
    parts.push(`⚠️ 口播**没拿到**：${t.reason}`)
    if (t.how_to_fix) parts.push(`修法：${t.how_to_fix}`)
    parts.push('在拿到口播之前，不要猜它说了什么；只能就画面/元数据做判断，并且要在结论里说明"没听到声音"。')
  }
  if (bundle.frames?.length) {
    parts.push(`关键帧 ${bundle.frames.length} 张（${bundle.frames.map((f) => `${f.index}@${f.t}s`).join(' ')}），`
      + `拼图一张：${bundle.sheet?.path || '(拼图失败)'}。用 read_image 看，别用 OCR 猜。`)
  }
  if (bundle.cuts?.ok) {
    const n = bundle.cuts.count
    parts.push(`镜头切点 ${n} 个${n ? `（${bundle.cuts.cuts.slice(0, 12).map((x) => `${x}s`).join(',')}${n > 12 ? '…' : ''}）` : '（一镜到底/或整片没换过镜）'}。`)
  }
  if (bundle.cached) parts.push('（这份是缓存，没重复跑转写；要重跑就传 force=true）')
  return parts.join(' ')
}

/**
 * 处理一条视频（含缓存判断）。
 *
 * @param {object} cfg 合并后的配置
 * @param {object} opts { file, force, frames, backend, language, log }
 */
export async function distillOne(cfg, opts) {
  const file = String(opts.file || '')
  const log = opts.log || (() => {})
  if (!existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
  let st
  try { st = statSync(file) } catch (e) { return { ok: false, error: `读不了文件：${e?.message ?? e}` } }
  if (!st.isFile()) return { ok: false, error: `不是文件：${file}` }
  if (!isVideo(file)) {
    return { ok: false, error: `不是视频扩展名：${extname(file) || '(无)'}`, hint: '支持 mp4/mov/mkv/avi/flv/webm/wmv/ts/m4v…' }
  }

  const workDir = join(WORK_DIR, videoId(file, st))
  const bundleFile = join(workDir, 'bundle.json')
  const framesDir = join(workDir, 'frames')

  // ── 缓存 ──
  if (!opts.force && existsSync(bundleFile)) {
    const old = readJson(bundleFile, null)
    if (old && old.ok && old.transcript?.ok) {
      log(`命中缓存：${workDir}`)
      return { ...old, cached: true, briefing: briefingOf({ ...old, cached: true }) }
    }
  }

  const ffmpeg = resolveFfmpeg(cfg, 'ffmpeg')
  const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
  if (!ffmpeg.path) return { ok: false, error: ffmpeg.hint || '没找到 ffmpeg' }
  if (!ffprobe.path) return { ok: false, error: ffprobe.hint || '没找到 ffprobe' }

  mkdirSync(workDir, { recursive: true })
  if (opts.force) wipe(framesDir)

  // ── 1. 元数据 ──
  log('读元数据…')
  const meta = probeVideo(ffprobe.path, file)
  if (!meta.ok) return { ok: false, error: meta.error, video: { path: file, name: basename(file) } }
  if (!meta.hasVideo) return { ok: false, error: '这个文件里没有视频流（是不是音频/图片改的后缀？）' }

  // ── 2. 音轨 ──
  let wavPath = ''
  let audioErr = ''
  if (meta.hasAudio) {
    log('抽音轨…')
    const wav = join(workDir, 'audio.wav')
    const a = extractAudio(ffmpeg.path, file, wav)
    if (a.ok) wavPath = a.path
    else audioErr = a.error
  }

  // ── 3. 关键帧 + 拼图 ──
  log('抽关键帧…')
  const nFrames = Math.max(1, Math.min(16, Number(opts.frames || cfg.frames) || 6))
  const times = pickTimes(meta.duration, nFrames)
  let frames = extractFrames(ffmpeg.path, file, framesDir, times)
  // 极端情况（seek 全失败）：退回"从 0 秒开始连取 N 帧"
  if (!frames.length) {
    log('按时间点抽帧全失败，退回从头连取…')
    frames = extractFrames(ffmpeg.path, file, framesDir, times.map((_, i) => i * 0.5))
  }
  let sheet = { ok: false }
  if (frames.length) sheet = contactSheet(ffmpeg.path, frames, join(workDir, 'sheet.jpg'))

  // ── 4. 镜头切点 ──
  let cuts = { ok: false, cuts: [], count: 0 }
  if (cfg.sceneDetect !== false) {
    log('数镜头切点…')
    cuts = detectCuts(ffmpeg.path, file, { threshold: Number(cfg.sceneThreshold) || 0.3 })
    if (!cuts.ok) cuts = { ok: false, cuts: [], count: 0, error: cuts.error }
  }

  // ── 5. 转写 ──
  log('转写口播…')
  const tr = await transcribe(cfg, {
    ffmpeg: ffmpeg.path,
    file,
    wav: wavPath,
    workDir,
    backend: opts.backend,
    language: opts.language || cfg.language,
    hasAudio: meta.hasAudio && !!wavPath,
    subtitleStreams: meta.subtitleStreams.length,
    log,
  })

  const duration = Number(meta.duration) || 0
  const transcript = tr.ok
    ? {
      ok: true,
      backend: tr.backend,
      language: tr.language || cfg.language || '',
      note: tr.note || '',
      segments: tr.segments || [],
      text: tr.text,
      charCount: (tr.text || '').replace(/\s/g, '').length,
      charsPerSec: (() => {
        const segs = tr.segments || []
        const speech = segs.length > 1 ? Number(segs[segs.length - 1].end) - Number(segs[0].start) : duration
        const cs = (tr.text || '').replace(/\s/g, '').length
        return speech > 0.5 ? Math.round((cs / speech) * 10) / 10 : 0
      })(),
    }
    : {
      ok: false,
      backend: tr.backend || 'none',
      reason: tr.reason || '转写失败',
      how_to_fix: tr.how_to_fix || '',
      tried: tr.tried || [],
      /** 声音抽不出来时也要说清楚，别让模型以为是"没人说话" */
      audioError: audioErr || '',
    }

  const bundle = {
    ok: true,
    video: { path: file, name: basename(file), sizeMB: Math.round((st.size / 1048576) * 10) / 10, mtime: st.mtime.toISOString() },
    meta,
    transcript,
    frames,
    sheet,
    cuts: { ok: cuts.ok, count: cuts.count || 0, cuts: cuts.cuts || [] },
    workDir,
    files: {
      transcriptMd: join(workDir, 'transcript.md'),
      transcriptJson: join(workDir, 'transcript.json'),
      metaJson: join(workDir, 'meta.json'),
      sheet: sheet.ok ? sheet.path : '',
      frames: frames.map((f) => f.path),
    },
    cached: false,
    generatedAt: new Date().toISOString(),
  }

  // ── 6. 落盘 ──
  try {
    writeFileSync(join(workDir, 'transcript.md'), renderTranscriptMd(bundle), 'utf8')
    writeJson(join(workDir, 'transcript.json'), transcript)
    writeJson(join(workDir, 'meta.json'), meta)
    writeFileSync(join(workDir, 'bundle.json'), JSON.stringify({ ...bundle, briefing: undefined }, null, 2) + '\n', 'utf8')
  } catch (e) {
    log(`落盘失败（不影响这次结果）：${e?.message ?? e}`)
  }
  if (!cfg.keepAudio && wavPath) {
    // 转写完就把 wav 删掉：一条 10 分钟的视频能占 20MB，留着没意义
    try { unlinkSync(wavPath) } catch { /* 删不掉就留着 */ }
  }

  return { ...bundle, briefing: briefingOf(bundle) }
}

/** 把 bundle 压缩成"给模型看的摘要"（完整数据太大，工具返回值要短） */
export function compactBundle(b, { maxChars = 12000 } = {}) {
  const t = b.transcript || {}
  const text = String(t.text || '')
  return {
    ok: b.ok,
    video: b.video,
    meta: {
      duration: b.meta.duration,
      durationHuman: b.meta.durationHuman,
      sizeMB: b.meta.sizeMB,
      width: b.meta.width,
      height: b.meta.height,
      fps: b.meta.fps,
      aspect: b.meta.aspect,
      videoCodec: b.meta.videoCodec,
      hasAudio: b.meta.hasAudio,
      audioCodec: b.meta.audioCodec,
      subtitleStreams: b.meta.subtitleStreams,
      bitrateKbps: b.meta.bitrateKbps,
      tags: b.meta.tags,
    },
    transcript: t.ok
      ? {
        ok: true,
        backend: t.backend,
        language: t.language,
        note: t.note,
        charCount: t.charCount,
        charsPerSec: t.charsPerSec,
        segments: (t.segments || []).slice(0, 400),
        text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（截断，全文见 transcript.md）` : text,
      }
      : { ok: false, backend: t.backend, reason: t.reason, how_to_fix: t.how_to_fix, tried: t.tried, audioError: t.audioError },
    frames: (b.frames || []).map((f) => ({ index: f.index, t: f.t, path: f.path })),
    sheet: b.sheet?.ok ? { path: b.sheet.path, cols: b.sheet.cols, rows: b.sheet.rows } : null,
    cuts: { ok: b.cuts?.ok, count: b.cuts?.count || 0, cuts: (b.cuts?.cuts || []).slice(0, 40) },
    workDir: b.workDir,
    files: b.files,
    cached: !!b.cached,
    briefing: b.briefing,
  }
}
