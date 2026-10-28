/**
 * lib/asr.mjs —— 把「声音」变成「字」：四条路，一条条试，谁成谁上
 * ============================================================================
 * 顺序就是能力从"白捡"到"要装东西"的顺序：
 *
 *   1. sidecar   视频旁边就躺着一份同名字幕（.srt/.vtt/.ass/.json）
 *                —— 下载站/剪辑软件经常顺手给，白捡的字幕最准（人写的）
 *   2. embedded  字幕压在容器里（mkv/mp4 常见），ffmpeg 一条命令就抽出来
 *   3. local     本地 faster-whisper（要 `video_asr_install` 装一次，之后纯离线）
 *   4. api       兼容 OpenAI 的 `/v1/audio/transcriptions`（有 key 就最快最省事）
 *
 * 🔴 一条铁律：**拿不到就老老实实说拿不到**。
 *    这里任何一路失败都只返回 `{ok:false, reason, how_to_fix}`，
 *    绝不返回空字符串冒充"这个视频没说话"——那会让模型对着空气编文案。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { PLUGIN_DIR, MODEL_DIR, maskKey, readSecretKey, venvPython, venvVendor } from './env.mjs'
import { run } from './media.mjs'

/* ─────────────────────────── 字幕解析 ─────────────────────────── */

const TS_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

/** "00:00:12,340" → 12.34 */
function toSec(s) {
  const m = String(s).match(TS_RE)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

/** SRT / VTT 共用：按空行切块，块里找「时间行 + 后面若干行文本」 */
export function parseTimedText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const segments = []
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const iTime = lines.findIndex((l) => l.includes('-->'))
    if (iTime < 0) continue
    const [a, bb] = lines[iTime].split('-->')
    const body = lines.slice(iTime + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (!body) continue
    segments.push({ start: toSec(a), end: toSec(bb), text: body })
  }
  return { segments, text: segments.map((s) => s.text).join('\n').trim() }
}

/** ASS/SSA：`Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,正文` */
export function parseAss(raw) {
  const segments = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!/^Dialogue:/i.test(line)) continue
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',')
    if (parts.length < 10) continue
    const body = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim()
    if (!body) continue
    segments.push({ start: toSec(parts[1]), end: toSec(parts[2]), text: body })
  }
  return { segments, text: segments.map((s) => s.text).join('\n').trim() }
}

/** whisper 的 json（faster-whisper / whisper.cpp 都长这样） */
export function parseWhisperJson(raw) {
  const j = JSON.parse(raw)
  const segs = Array.isArray(j.segments) ? j.segments : []
  const segments = segs.map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || '').trim(),
  })).filter((s) => s.text)
  const text = String(j.text || segments.map((s) => s.text).join('')).trim()
  return { segments, text, language: j.language || '' }
}

const SIDECAR_EXT = ['.srt', '.vtt', '.ass', '.ssa', '.json', '.txt']

/**
 * 找视频旁边的字幕。同名优先（`abc.mp4` + `abc.srt`），
 * 其次 `abc.zh.srt` / `abc.autosub.srt` 这类带语言后缀的。
 * `.txt` / `.json` 只认内容看着像字幕的（防止把随手记的笔记当字幕）。
 */
export function findSidecar(file) {
  const dir = dirname(file)
  const base = basename(file, extname(file))
  for (const ext of SIDECAR_EXT) {
    const p = join(dir, base + ext)
    if (existsSync(p)) {
      const v = readSidecar(p)
      if (v) return v
    }
  }
  let entries = []
  try { entries = readdirSync(dir) } catch { entries = [] }
  for (const name of entries) {
    if (!name.startsWith(base + '.')) continue
    const p = join(dir, name)
    if (!SIDECAR_EXT.includes(extname(name).toLowerCase())) continue
    const v = readSidecar(p)
    if (v) return v
  }
  return null
}

function readSidecar(p) {
  try {
    if (statSync(p).size > 2 * 1024 * 1024) return null
    const raw = readFileSync(p, 'utf8')
    const low = extname(p).toLowerCase()
    let parsed
    if (low === '.ass' || low === '.ssa') parsed = parseAss(raw)
    else if (low === '.json') parsed = parseWhisperJson(raw)
    else if (low === '.txt') {
      const text = raw.replace(/\r/g, '').trim()
      // 随手记的笔记也长这样，所以只要求"够长"；不参与时间轴
      if (text.length < 20) return null
      parsed = { segments: [], text }
    } else parsed = parseTimedText(raw)
    if (!parsed || !parsed.text || parsed.text.trim().length < 2) return null
    return { path: p, kind: low.replace('.', ''), ...parsed }
  } catch { return null }
}

/* ─────────────────────────── 内嵌字幕 ─────────────────────────── */

/** 从容器里抽第一条字幕流，转成 srt 再解析 */
export function embeddedSubtitle(ffmpeg, file, outSrt) {
  const r = run(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-map', '0:s:0', outSrt], { timeout: 120_000 })
  if (r.status !== 0 || !existsSync(outSrt)) {
    return { ok: false, error: `内嵌字幕抽不出来：${(r.stderr || r.error || '').slice(0, 200)}` }
  }
  const parsed = parseTimedText(readFileSync(outSrt, 'utf8'))
  if (!parsed.text) return { ok: false, error: '内嵌字幕流是空的' }
  return { ok: true, path: outSrt, kind: 'embedded-srt', ...parsed }
}

/* ─────────────────────────── 本地 faster-whisper ─────────────────────────── */

/** 本地 ASR 到底能不能跑（不真的转写，但**会真的验一次 import**） */
export function localStatus(cfg) {
  const v = venvVendor()
  if (!v.ready) {
    return {
      ready: false,
      reason: v.reason || '还没装本地转写引擎（faster-whisper）',
      detail: v.error || '',
      how_to_fix: '说一句「装一下本地转写」——或者直接调 video_asr_install（约 2–5 分钟，一次装好永久离线可用）。',
    }
  }
  return {
    ready: true,
    python: v.python,
    version: v.version,
    modelSize: cfg?.modelSize || 'small',
    modelDir: MODEL_DIR,
    /** 模型没下过也不拦：第一次转写时 asr.py 会自己下（走 hfMirror） */
    note: `faster-whisper ${v.version}`,
  }
}

/**
 * 跑本地转写。asr.py 只往 stdout 打一行 JSON，进度全在 stderr —— 所以这里能干净地解析。
 */
export function localAsr(cfg, wavPath, { language = 'zh', modelSize = '', timeoutSec = 1800 } = {}) {
  const py = venvPython()
  if (!existsSync(py)) return { ok: false, backend: 'local', reason: localStatus(cfg).reason, how_to_fix: localStatus(cfg).how_to_fix }
  const script = join(PLUGIN_DIR, 'tools', 'asr.py')
  if (!existsSync(script)) return { ok: false, backend: 'local', reason: `插件里缺 tools/asr.py（${script}）` }
  const r = run(py, [
    script, wavPath,
    '--model', String(modelSize || cfg?.modelSize || 'small'),
    '--language', String(language || 'auto'),
    '--model-dir', MODEL_DIR,
    '--mirror', String(cfg?.hfMirror || ''),
  ], {
    timeout: Math.max(60, Number(timeoutSec) || 1800) * 1000,
    /**
     * 🔴 Windows 上必须钉死编码：python 往**管道**写中文时默认用系统代码页（cp936/GBK），
     *    而 Node 按 utf8 解码 ⇒ 转写结果全是 `�ܶ�`。两个字都要：PYTHONIOENCODING 管 stdio，
     *    PYTHONUTF8 让整个解释器走 UTF-8 模式。
     */
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  })

  const line = String(r.stdout || '').split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
  if (!line) {
    const tail = (r.stderr || r.error || '').slice(-500)
    return { ok: false, backend: 'local', reason: '本地转写没返回结果', detail: tail }
  }
  let j
  try { j = JSON.parse(line) } catch { return { ok: false, backend: 'local', reason: '本地转写输出解析不了', detail: line.slice(0, 300) } }
  if (!j.ok) return { ok: false, backend: 'local', reason: j.error || '本地转写失败', detail: String(j.detail || '').slice(0, 500) }
  return {
    ok: true,
    backend: 'local',
    language: j.language || '',
    text: String(j.text || '').trim(),
    segments: Array.isArray(j.segments) ? j.segments : [],
    note: j.model ? `faster-whisper ${j.model}` : '',
  }
}

/* ─────────────────────────── 兼容 OpenAI 的 API ─────────────────────────── */

function endpointOf(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  if (/\/audio\/transcriptions$/.test(b)) return b
  if (/\/v1$/.test(b)) return `${b}/audio/transcriptions`
  return `${b}/v1/audio/transcriptions`
}

export function apiStatus(cfg) {
  const { key, from } = readSecretKey(cfg)
  const url = endpointOf(cfg?.apiBaseUrl)
  if (!url) return { ready: false, reason: '没配 apiBaseUrl', how_to_fix: '要么配 interface 地址，要么用本地引擎（video_asr_install）' }
  if (!key) return { ready: false, reason: `没配 API Key（${endpointOf(cfg?.apiBaseUrl)} 需要）`, how_to_fix: '把 key 给我，我用 video_config 存进 secret.json（不进日志）' }
  return { ready: true, endpoint: url, keyMasked: maskKey(key), keyFrom: from, model: cfg?.apiModel || 'whisper-1' }
}

/**
 * 调 API 转写。multipart 直接用 Node 自带 FormData/Blob（node ≥ 18 就有），
 * 不引任何 SDK —— 少一个依赖就少一个装不上的理由。
 */
export async function apiAsr(cfg, wavPath, { language = 'zh', timeoutSec = 1800 } = {}) {
  const st = apiStatus(cfg)
  if (!st.ready) return { ok: false, backend: 'api', reason: st.reason, how_to_fix: st.how_to_fix }
  const { key } = readSecretKey(cfg)
  let buf
  try { buf = readFileSync(wavPath) } catch (e) { return { ok: false, backend: 'api', reason: `读不了 wav：${e?.message ?? e}` } }

  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), basename(wavPath))
  form.append('model', String(cfg?.apiModel || 'whisper-1'))
  if (language && language !== 'auto') form.append('language', String(language))
  form.append('response_format', 'verbose_json')

  let res
  try {
    res = await fetch(st.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(Math.max(60, Number(timeoutSec) || 1800) * 1000),
    })
  } catch (e) {
    return { ok: false, backend: 'api', reason: `请求打不通：${e?.message ?? e}`, endpoint: st.endpoint }
  }
  const bodyText = await res.text().catch(() => '')
  if (!res.ok) {
    return {
      ok: false, backend: 'api',
      reason: `接口返回 ${res.status}`,
      detail: bodyText.slice(0, 500),
      endpoint: st.endpoint,
      how_to_fix: res.status === 401 || res.status === 403
        ? 'Key 不对或没权限 —— 换一个 key，或者改用本地引擎。'
        : '看看 apiBaseUrl / apiModel 对不对（有些服务不认 verbose_json）。',
    }
  }
  let j
  try { j = JSON.parse(bodyText) } catch { return { ok: false, backend: 'api', reason: '接口返回的不是 JSON', detail: bodyText.slice(0, 300) } }
  const segments = Array.isArray(j.segments)
    ? j.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
    : []
  const text = String(j.text || segments.map((s) => s.text).join('\n') || '').trim()
  if (!text) return { ok: false, backend: 'api', reason: '接口返回了空文本（这个视频可能真的没人声）', endpoint: st.endpoint }
  return { ok: true, backend: 'api', language: j.language || '', text, segments, note: st.model }
}

/* ─────────────────────────── 总调度 ─────────────────────────── */

/**
 * 转写一条视频（**纯函数式**：给什么用什么，不读全局配置）。
 *
 * @param {object} cfg       合并后的配置
 * @param {object} opts
 * @param {string} opts.file 视频路径
 * @param {string} opts.wav  已抽好的 16k wav（local/api 用得到）
 * @param {string} opts.workDir 工作目录（内嵌字幕临时文件放这）
 * @param {string} opts.backend  auto|sidecar|embedded|local|api|none
 * @param {string} opts.language
 * @param {boolean} opts.hasAudio 视频有没有音轨（没音轨就别浪费时间抽 wav 了）
 * @param {function} opts.log
 */
export async function transcribe(cfg, opts) {
  const backend = String(opts.backend || cfg?.backend || 'auto')
  const tried = []
  const done = (r) => ({ ...r, tried })
  const push = (name, r) => {
    tried.push({ backend: name, ok: !!r.ok, reason: r.reason || '' })
    return r
  }

  if (backend === 'none') {
    return done({ ok: false, reason: 'backend=none（配置里关掉了转写）', how_to_fix: '把 backend 改回 auto' })
  }

  /* 1. 旁边有字幕 */
  if (backend === 'auto' || backend === 'sidecar') {
    const sc = findSidecar(opts.file)
    const r = push('sidecar', sc
      ? { ok: true, backend: 'sidecar', text: sc.text, segments: sc.segments, note: `同名字幕：${basename(sc.path)}` }
      : { ok: false, reason: '视频旁边没有同名字幕' })
    if (r.ok) return done({ ...r, backend: 'sidecar' })
    if (backend === 'sidecar') return done({ ok: false, reason: r.reason, tried })
  }

  /* 2. 容器里有字幕流 */
  if (backend === 'auto' || backend === 'embedded') {
    const hasSub = Number(opts.subtitleStreams || 0) > 0
    if (hasSub || backend === 'embedded') {
      const outSrt = join(opts.workDir, 'embedded.srt')
      const r = push('embedded', embeddedSubtitle(opts.ffmpeg, opts.file, outSrt))
      if (r.ok) return done({ ...r, backend: 'embedded' })
      if (backend === 'embedded') return done({ ok: false, reason: r.reason, tried })
    } else {
      tried.push({ backend: 'embedded', ok: false, reason: '没有内嵌字幕流' })
    }
  }

  /* 3. 本地引擎 */
  if (backend === 'auto' || backend === 'local') {
    const st = localStatus(cfg)
    if (!st.ready) {
      tried.push({ backend: 'local', ok: false, reason: st.reason })
      if (backend === 'local') return done({ ok: false, reason: st.reason, how_to_fix: st.how_to_fix, tried })
    } else if (!opts.hasAudio) {
      tried.push({ backend: 'local', ok: false, reason: '视频没有音轨' })
      if (backend === 'local') return done({ ok: false, reason: '这个视频没有音轨，转写不了', tried })
    } else {
      const r = push('local', localAsr(cfg, opts.wav, { language: opts.language, timeoutSec: cfg?.asrTimeoutSec }))
      if (r.ok) return done({ ...r, backend: 'local' })
      if (backend === 'local') return done({ ok: false, reason: r.reason, detail: r.detail, tried })
    }
  }

  /* 4. 云端 API */
  if (backend === 'auto' || backend === 'api') {
    const st = apiStatus(cfg)
    if (!st.ready) {
      tried.push({ backend: 'api', ok: false, reason: st.reason })
      if (backend === 'api') return done({ ok: false, reason: st.reason, how_to_fix: st.how_to_fix, tried })
    } else if (!opts.hasAudio) {
      tried.push({ backend: 'api', ok: false, reason: '视频没有音轨' })
    } else {
      const r = push('api', await apiAsr(cfg, opts.wav, { language: opts.language, timeoutSec: cfg?.asrTimeoutSec }))
      if (r.ok) return done({ ...r, backend: 'api' })
      if (backend === 'api') return done({ ok: false, reason: r.reason, detail: r.detail, how_to_fix: r.how_to_fix, tried })
    }
  }

  /**
   * 🔴 一条铁律的落地：**失败原因要一条条摊开说**，不许用一句套话糊过去。
   *    踩过的坑：这里原来写死了「没有同名字幕、没有内嵌字幕、本地引擎没装、云端 API 没配」，
   *    结果真机上引擎明明装好了、只是 import 失败，返回的却是"没装" ——
   *    使用者按这句话去重装一遍，白折腾。现在原因全部来自 `tried` 的实际返回值。
   */
  const brief = tried
    .map((t) => `${t.backend}（${String(t.reason || '失败').slice(0, 80)}）`)
    .join('；')
  const noAudio = !opts.hasAudio
  return done({
    ok: false,
    backend: 'none',
    reason: noAudio
      ? `这个视频没有可用音轨，转写不了 —— ${brief}`
      : `四条路都没走通 —— ${brief}`,
    how_to_fix: noAudio
      ? '没有声音就只能看画面：用关键帧拆构图/字幕/出镜方式，并在结论里写明"这条没有口播"。'
      : '二选一：① 说「装本地转写」（video_asr_install，离线可用）② 给我一个兼容 OpenAI 的转写接口 + key（video_config 配 apiBaseUrl/apiModel，key 存 secret.json）。',
    tried,
  })
}
