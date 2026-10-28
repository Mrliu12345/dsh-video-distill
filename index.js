/**
 * dsh-video-distill —— DSH 插件「视频蒸馏」的宿主半端
 * ============================================================================
 * 一句话：你说「D 盘那个目录里的视频，看看人家是怎么做的，给我写几条同款文案」，
 * 这个插件负责把视频**拆成模型读得懂的材料**，模型负责拆解和重写。
 *
 * 它注册 7 个工具（模型自己会挑，使用者不用记名字）：
 *   video_status        体检：ffmpeg / 转写引擎 / 目录 / 配置，一次说清
 *   video_config        改配置（含 API Key，进 secret.json 不进日志）
 *   video_scan          扫目录：有哪些片子、多长、竖屏横屏、有没有人声/字幕
 *   video_distill       ⭐ 主力：一条片子 → 转写 + 关键帧 + 拼图 + 镜头切点 + 元数据
 *   video_save          把拆解/文案存成 md（`out/<日期>/<标题>.md`）
 *   video_guide         把「怎么拆、怎么写」的手册原文给模型
 *   video_asr_install   装本地转写引擎（faster-whisper，后台装，装完离线可用）
 *
 * 设计上的三条自我约束：
 *   ① 不 import 任何第三方包（profile 里可能一个都没有，裸 import 会整条插件不激活）；
 *   ② 一切运行数据在 `$DSH_HOME/video-distill/`，插件包目录只读；
 *   ③ **不编内容**：转写拿不到就报"拿不到"并给出修法，绝不返回空文本让模型自由发挥。
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DEFAULTS, HOME_DIR, OUT_DIR, PLUGIN_DIR, WORK_DIR, ensureDirs, findPython,
  loadConfig, maskKey, readSecretKey, resolveFfmpeg, safeName, writeConfig, writeSecretKey,
} from './lib/env.mjs'
import { probeVideo, scanDir } from './lib/media.mjs'
import { compactBundle, distillOne } from './lib/distill.mjs'
import { apiStatus, localStatus } from './lib/asr.mjs'
import { envReport, installLogTail, installState, startInstall, writeRuntimeLog } from './lib/install.mjs'
import { GUIDE_FILE, guideText } from './lib/guide.mjs'
import { makeTool } from './lib/toolkit.mjs'

export const name = 'video-distill'
export const inject = ['tools']

const PLUGIN_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '') } catch { return '' }
})()

/** 工具返回值一律过这里：宿主只吃"无损 JSON" */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

export function apply(ctx) {
  const log = (msg) => {
    try { ctx.logger?.info?.(`[video-distill] ${msg}`) } catch { /* 没有 logger 就算了 */ }
    writeRuntimeLog(msg)
  }
  ensureDirs()

  /** 运行期的真相：每次用之前从 config.json 重新合成（改了就生效，不用重启） */
  let cfg = loadConfig()
  const refresh = () => { cfg = loadConfig(); return cfg }

  const tool = (spec) => ctx.tools.register(makeTool({
    ...spec,
    async execute(args) {
      return safe(await spec.execute(args || {}))
    },
  }))

  /**
   * `parameters` 是**扁平参数规格**（`{ 名字: { type, description } }`），
   * 必填名单走 `required: [...]`；编译成 JSON Schema 的活在 lib/toolkit.mjs 里。
   * 🔴 别在这里写 `{ type:'object', properties:{…} }` —— 那会被当成三个参数名。
   */
  const params = (properties) => properties

  log(`已加载 v${PLUGIN_VERSION}（家目录 ${HOME_DIR}）`)

  /* ────────────────────────── 1. 体检 ────────────────────────── */

  tool({
    name: 'video_status',
    description: '视频蒸馏插件的体检：ffmpeg/ffprobe 在不在、本地转写引擎装没装、API 转写配没配、'
      + '默认目录有没有设、已经蒸馏过几条、成稿在哪。'
      + '🔴 只要出现「转写拿不到」「ffmpeg 找不到」「目录没设」，先调它一次，别猜。',
    parameters: params({
      verbose: { type: 'boolean', description: '是否带安装日志尾巴和 Python 探测细节（默认 false）' },
    }),
    async execute(args) {
      refresh()
      const ffmpeg = resolveFfmpeg(cfg, 'ffmpeg')
      const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
      const local = localStatus(cfg)
      const api = apiStatus(cfg)
      const inst = installState()
      let workCount = 0
      try { workCount = readdirSync(WORK_DIR).length } catch { workCount = 0 }
      const out = {
        ok: true,
        version: PLUGIN_VERSION,
        home: HOME_DIR,
        dir: cfg.dir || '(没设)',
        dirExists: cfg.dir ? existsSync(cfg.dir) : false,
        ffmpeg: { path: ffmpeg.path, version: ffmpeg.version, source: ffmpeg.source, hint: ffmpeg.hint || undefined },
        ffprobe: { path: ffprobe.path, version: ffprobe.version, source: ffprobe.source, hint: ffprobe.hint || undefined },
        asr: {
          backend: cfg.backend,
          local: { ready: local.ready, reason: local.reason || '', how_to_fix: local.how_to_fix || '', python: local.python || '' },
          api: { ready: api.ready, reason: api.reason || '', endpoint: api.endpoint || '', model: api.model || '', keyMasked: api.keyMasked || '' },
          install: { running: !!inst.running, ok: !!inst.ok, step: inst.step || 'idle', model: inst.model || '', error: inst.error || '' },
        },
        counts: { distilledWorkDirs: workCount, outDir: cfg.outDir || OUT_DIR },
        next: [],
      }
      if (!ffmpeg.path || !ffprobe.path) out.next.push('装 ffmpeg（winget install Gyan.FFmpeg），或在 video_config 里指定 ffmpegPath')
      if (!cfg.dir) out.next.push('用 video_config 设一个默认视频目录（dir），或者调 video_scan 时直接传目录')
      if (!local.ready && !api.ready) out.next.push('转写还没有着落：调 video_asr_install 装本地引擎，或配 apiBaseUrl + API Key')
      if (args.verbose) {
        out.env = envReport(cfg)
        out.installLogTail = installLogTail(40)
        out.paths = { config: join(HOME_DIR, 'config.json'), secret: join(HOME_DIR, 'secret.json'), work: WORK_DIR, out: OUT_DIR, guide: GUIDE_FILE }
      }
      return out
    },
  })

  /* ────────────────────────── 2. 配置 ────────────────────────── */

  tool({
    name: 'video_config',
    description: '读/改视频蒸馏的配置。常用：设默认视频目录（dir）、切转写后端（backend）、'
      + '设兼容 OpenAI 的转写接口（apiBaseUrl / apiModel）和 Key（apiKey，只进 secret.json，不进日志）。'
      + '配置存在 `$DSH_HOME/video-distill/config.json`，改完立刻生效，不用重启。',
    parameters: params({
      action: {
        type: 'string',
        description: 'get（看当前配置，默认）| set（改）| defaults（看所有可改项和默认值）| where（文件在哪）',
      },
      dir: { type: 'string', description: '默认视频目录，例如 D:\\videos\\样例' },
      outDir: { type: 'string', description: '成稿目录（默认 $DSH_HOME/video-distill/out）' },
      backend: { type: 'string', description: 'auto | sidecar | embedded | local | api | none' },
      language: { type: 'string', description: '转写语言：zh / en / ja / auto' },
      modelSize: { type: 'string', description: '本地模型档位：tiny | base | small | medium | large-v3' },
      frames: { type: 'number', description: '每条视频抽几张关键帧（1–16，默认 6）' },
      apiBaseUrl: { type: 'string', description: '兼容 OpenAI 的转写接口根地址，例 https://api.siliconflow.cn/v1' },
      apiModel: { type: 'string', description: '转写模型名，例 FunAudioLLM/SenseVoiceSmall 或 whisper-1' },
      apiKey: { type: 'string', description: '接口 Key（只写不读：存进 secret.json，返回里只给打码后的样子）' },
      clearApiKey: { type: 'boolean', description: '清掉已存的 Key' },
      patch: { type: 'string', description: '其余配置项，用 JSON 字符串传，例 {"sceneDetect":false,"minSec":5}' },
    }),
    async execute(args = {}) {
      refresh()
      const action = String(args.action || 'get').toLowerCase()

      if (action === 'defaults') {
        return {
          ok: true,
          configFile: join(HOME_DIR, 'config.json'),
          defaults: DEFAULTS,
          note: '这些是默认值；config.json 里只存你改过的项。',
        }
      }
      if (action === 'where') {
        const { key, from } = readSecretKey(cfg)
        return {
          ok: true,
          configFile: join(HOME_DIR, 'config.json'),
          secretFile: join(HOME_DIR, 'secret.json'),
          workDir: WORK_DIR,
          outDir: cfg.outDir || OUT_DIR,
          guide: GUIDE_FILE,
          apiKey: key ? `已存（${from}，${maskKey(key)}）` : '没存',
        }
      }

      if (action === 'set') {
        const fields = ['dir', 'outDir', 'backend', 'language', 'modelSize', 'apiBaseUrl', 'apiModel']
        const patch = {}
        const changed = []
        for (const f of fields) {
          if (args[f] === undefined) continue
          patch[f] = args[f]
          changed.push(f)
        }
        if (args.frames !== undefined) {
          // 1–16 钳死，别让一个手滑的 1000 把磁盘塞满
          patch.frames = Math.max(1, Math.min(16, Math.round(Number(args.frames) || 6)))
          changed.push('frames')
        }
        if (args.patch) {
          let extra
          try { extra = JSON.parse(String(args.patch)) } catch { return { ok: false, error: 'patch 不是合法 JSON', got: String(args.patch).slice(0, 200) } }
          for (const [k, v] of Object.entries(extra || {})) {
            if (!(k in DEFAULTS)) return { ok: false, error: `不认识的配置项：${k}`, known: Object.keys(DEFAULTS) }
            patch[k] = v
            changed.push(k)
          }
        }
        let keyInfo = ''
        if (args.clearApiKey === true) {
          writeSecretKey('')
          keyInfo = '已清掉 API Key'
        } else if (typeof args.apiKey === 'string' && args.apiKey.trim()) {
          writeSecretKey(args.apiKey.trim())
          keyInfo = `API Key 已存（${maskKey(args.apiKey.trim())}）`
        }
        const next = Object.keys(patch).length ? writeConfig(patch) : loadConfig()
        cfg = next
        log(`配置已改：${changed.join(',') || '(无)'}${keyInfo ? ' ' + keyInfo : ''}`)
        return {
          ok: true,
          changed: [...new Set(changed)],
          key: keyInfo || undefined,
          config: { ...next, apiKey: undefined },
          note: changed.includes('dir') ? `默认目录 → ${next.dir}` : undefined,
        }
      }

      const { key, from } = readSecretKey(cfg)
      return {
        ok: true,
        config: { ...cfg },
        apiKey: key ? `已存（${from}，${maskKey(key)}）` : '没存',
        configFile: join(HOME_DIR, 'config.json'),
        defaultsHint: '想看全部可改项：action=defaults',
      }
    },
  })

  /* ────────────────────────── 3. 扫目录 ────────────────────────── */

  tool({
    name: 'video_scan',
    description: '扫一个目录，列出里面的视频（名字/大小/时长/分辨率/竖屏横屏/有没有人声/有没有内嵌字幕）。'
      + '🔴 使用者的原话通常是「D 盘那个目录里有一些视频」—— 这时先调它，拿到清单再决定蒸馏哪几条，'
      + '别一上来就整目录全蒸（慢、也贵）。目录参数留空就用配置里的默认目录。',
    parameters: params({
      dir: { type: 'string', description: '视频目录，绝对路径；留空用配置里的 dir' },
      recursive: { type: 'boolean', description: '是否连子目录一起扫（默认只扫一层）' },
      limit: { type: 'number', description: '最多列多少个（默认取配置 maxVideos=20，上限 200）' },
      probe: { type: 'boolean', description: '是否逐个读元数据（默认 true；只想要文件名清单可传 false）' },
      minSec: { type: 'number', description: '过滤：短于这个秒数的不要（默认配置 minSec=3）' },
      maxSec: { type: 'number', description: '过滤：长于这个秒数的不要（默认配置 maxSec=1800）' },
    }),
    async execute(args = {}) {
      refresh()
      const dir = String(args.dir || cfg.dir || '').trim()
      if (!dir) {
        return {
          ok: false,
          error: '没给目录，配置里也没有默认目录',
          hint: '问使用者是哪个目录（要绝对路径），或者用 video_config 设 dir 之后重试。',
        }
      }
      if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}`, hint: '让使用者确认路径（Windows 路径要带盘符，别用 ~）' }
      let st
      try { st = statSync(dir) } catch (e) { return { ok: false, error: `读不了这个目录：${e?.message ?? e}` } }
      if (!st.isDirectory()) {
        // 使用者也可能直接给了一个文件
        if (st.isFile()) {
          const m = await probeOne(dir)
          return { ok: true, dir, count: 1, videos: [m], note: '你给的是一个文件，不是目录' }
        }
        return { ok: false, error: `不是目录：${dir}` }
      }

      const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || cfg.maxVideos || 20)))
      const scan = scanDir(dir, { recursive: args.recursive === true, maxVideos: limit })
      if (!scan.ok) return { ok: false, error: scan.error, dir }
      if (!scan.videos.length) {
        return {
          ok: true, dir, count: 0, videos: [],
          hint: '这个目录里没有视频文件（认 mp4/mov/mkv/avi/flv/webm/wmv/ts/m4v）。'
            + '如果视频在子目录里，加 recursive:true；如果确认里面就是空的/是别的东西，跟使用者说清楚。',
        }
      }

      const probe = args.probe !== false
      const minSec = Number(args.minSec ?? cfg.minSec) || 0
      const maxSec = Number(args.maxSec ?? cfg.maxSec) || 0
      let rows = scan.videos
      if (probe) {
        rows = []
        for (const v of scan.videos) rows.push(await probeOne(v.path, v))
      }
      const before = rows.length
      if (minSec > 0) rows = rows.filter((r) => !r.duration || r.duration >= minSec)
      if (maxSec > 0) rows = rows.filter((r) => !r.duration || r.duration <= maxSec)

      return {
        ok: true,
        dir,
        count: rows.length,
        filteredOut: before - rows.length,
        truncated: scan.truncated || undefined,
        videos: rows,
        next: rows.length
          ? '挑一条先蒸（video_distill video=<path>），看完拆解再决定要不要批量。'
          : '过滤条件把视频滤没了 —— 放宽 minSec/maxSec 再看一次。',
      }
    },
  })

  /* ────────────────────────── 4. 蒸馏（主力） ────────────────────────── */

  tool({
    name: 'video_distill',
    description: '⭐ 把一条视频拆成模型读得懂的材料：口播转写（带时间轴）、关键帧、关键帧拼图、'
      + '镜头切点、元数据（时长/分辨率/帧率/语速）。返回里带 frames 的绝对路径和 sheet 拼图路径 —— '
      + '**用 read_image 看图，用 transcript.md 读口播**，然后按 video_guide 的十项拆解。'
      + '有缓存：同一条视频第二次调用秒回；改了视频或要重跑就传 force=true。'
      + '⚠️ 要一条一条来：先蒸 1 条看清结构，别一口气蒸一整个目录。',
    parameters: params({
      video: { type: 'string', description: '视频路径（绝对路径；只给文件名则相对配置的 dir 找）' },
      dir: { type: 'string', description: '也可以给个目录，配合 top 蒸前 N 条' },
      top: { type: 'number', description: '给 dir 时蒸前几条（默认 1，上限 10）' },
      force: { type: 'boolean', description: '无视缓存重跑转写/抽帧' },
      frames: { type: 'number', description: '抽几张关键帧（1–16，默认配置值 6）' },
      backend: { type: 'string', description: '临时换转写后端：auto|sidecar|embedded|local|api|none' },
      language: { type: 'string', description: '临时换语言：zh|en|ja|auto' },
    }),
    async execute(args = {}) {
      refresh()
      const ffmpeg = resolveFfmpeg(cfg, 'ffmpeg')
      if (!ffmpeg.path) return { ok: false, error: ffmpeg.hint, hint: '先用 video_status 看清楚缺什么' }

      const targets = resolveTargets(args, cfg)
      if (targets.error) return { ok: false, error: targets.error, hint: targets.hint }

      const items = []
      const failures = []
      for (const file of targets.files) {
        log(`开始蒸馏：${file}`)
        try {
          const b = await distillOne(cfg, {
            file,
            force: args.force === true,
            frames: args.frames,
            backend: args.backend,
            language: args.language,
            log,
          })
          if (!b.ok) {
            failures.push({ video: file, error: b.error })
            log(`失败：${file} → ${b.error}`)
            continue
          }
          const c = compactBundle(b)
          items.push(c)
          log(`完成：${basename(file)}（转写 ${c.transcript.ok ? c.transcript.charCount + ' 字' : '没拿到'}，帧 ${c.frames.length} 张）`)
        } catch (e) {
          failures.push({ video: file, error: String(e?.message ?? e) })
          log(`崩了：${file} → ${e?.stack ?? e}`)
        }
      }

      if (!items.length) {
        return {
          ok: false,
          error: failures.length ? failures[0].error : '一条都没蒸成',
          failures,
          hint: '看 video_status 的 asr / ffmpeg 两段；缺什么补什么再试。',
        }
      }

      if (items.length === 1) {
        return { ...items[0], failures: failures.length ? failures : undefined }
      }
      return {
        ok: true,
        count: items.length,
        items,
        failures: failures.length ? failures : undefined,
        next: '多条对比时：先做一张横向对照表（钩子类型/骨架/语速/切点数/转化方式），再说共同的赢法。',
      }
    },
  })

  /* ────────────────────────── 5. 存成稿 ────────────────────────── */

  tool({
    name: 'video_save',
    description: '把拆解报告 / 生成的文案存成 markdown，落到 `out/<日期>/<标题>.md`（或配置的 outDir）。'
      + '拆解+模板+文案**一次写完再存**，别分成七八个文件。',
    parameters: params({
      title: { type: 'string', description: '标题（也当文件名，会去掉非法字符）' },
      content: { type: 'string', description: 'markdown 全文' },
      kind: { type: 'string', description: 'analysis（拆解）| script（文案）| both（默认）' },
      source: { type: 'string', description: '来源视频文件名或路径（写进文首，方便回查）' },
      dir: { type: 'string', description: '存到哪个目录（默认配置 outDir 或 $DSH_HOME/video-distill/out）' },
    }),
    required: ['title', 'content'],
    async execute(args = {}) {
      refresh()
      const title = String(args.title || '').trim()
      const content = String(args.content || '')
      if (!title) return { ok: false, error: '得给个标题（也当文件名）' }
      if (content.trim().length < 20) return { ok: false, error: '内容太短了（<20 字），像是没写完', got: content.length }

      const baseDir = String(args.dir || cfg.outDir || OUT_DIR)
      const day = new Date()
      const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      const folder = join(baseDir, ymd)
      try { mkdirSync(folder, { recursive: true }) } catch (e) { return { ok: false, error: `建不了目录：${e?.message ?? e}`, dir: folder } }

      const kind = ['analysis', 'script', 'both'].includes(String(args.kind)) ? String(args.kind) : 'both'
      const head = [
        `<!-- kind: ${kind} · 生成于 ${day.toISOString()} · 来源：${args.source ? String(args.source) : '未注明'} -->`,
        '',
      ].join('\n')
      const body = `${head}${content.trim()}\n`

      let file = join(folder, `${safeName(title, 70)}.md`)
      let n = 1
      while (existsSync(file)) {
        n += 1
        file = join(folder, `${safeName(title, 70)}-${n}.md`)
        if (n > 50) break
      }
      try {
        writeFileSync(file, body, 'utf8')
      } catch (e) {
        return { ok: false, error: `写不进去：${e?.message ?? e}`, path: file }
      }
      log(`成稿已存：${file}（${body.length} 字）`)
      return {
        ok: true,
        path: file,
        chars: body.length,
        kind,
        note: '把这个路径告诉使用者（点得开的那种）。',
      }
    },
  })

  /* ────────────────────────── 6. 手册 ────────────────────────── */

  tool({
    name: 'video_guide',
    description: '取「视频蒸馏手册」原文：拆解十项、可复用模板、生成同款文案的硬要求（字数/语速/禁区）。'
      + '🔴 第一次给使用者做拆解或写文案之前，**先调它一次**，照着做，别凭感觉写。',
    parameters: params({}),
    async execute() {
      const g = guideText()
      if (!g.ok) return { ok: false, error: g.error, path: g.path }
      return { ok: true, path: g.path, text: g.text }
    },
  })

  /* ────────────────────────── 7. 装本地转写 ────────────────────────── */

  tool({
    name: 'video_asr_install',
    description: '装本地语音转写引擎（faster-whisper：venv + pip + 预下模型，约 2–5 分钟，一次装好永久离线可用）。'
      + '**后台装，立刻返回**；进度用 video_status 看（install.step / running），装完 local.ready=true。'
      + '适合：没有字幕、又不方便把视频传到云上的情况。有 API 接口的话不装也可以（video_config 配 apiBaseUrl+apiKey）。',
    parameters: params({
      model: { type: 'string', description: '模型档位：tiny(最快) / base / small(默认，中文口播够用) / medium / large-v3' },
      downloadModel: { type: 'boolean', description: '是否顺便把模型下下来（默认 true；false 就等第一次转写时再下）' },
      check: { type: 'boolean', description: '只看现在能不能用，不装' },
    }),
    async execute(args = {}) {
      refresh()
      if (args.check === true) {
        const local = localStatus(cfg)
        const py = findPython(cfg)
        return {
          ok: true,
          ready: local.ready,
          reason: local.reason || '',
          python: { found: !!py.cmd, version: py.version, source: py.source },
          install: installState(),
          log: installLogTail(15),
        }
      }
      const r = startInstall(cfg, { model: args.model, downloadModel: args.downloadModel !== false })
      return {
        ...r,
        note: r.alreadyRunning
          ? '已经在装了，别重复点；video_status 里能看到 step 走到哪一步。'
          : '装的时候可以先干别的（比如先蒸一条有字幕的视频）。装完要再看的话调 video_status。',
      }
    },
  })
}

/* ─────────────────────────── 内部小工具 ─────────────────────────── */

/** 把一条视频 probe 成"清单行"，字段名对模型友好 */
async function probeOne(file, seed) {
  const cfg = loadConfig()
  const ffprobe = resolveFfmpeg(cfg, 'ffprobe')
  const base = {
    name: seed?.name || basename(file),
    path: file,
    sizeMB: seed?.sizeMB,
    mtime: seed?.mtime,
  }
  if (!ffprobe.path) return { ...base, error: '没有 ffprobe，读不了时长' }
  const m = probeVideo(ffprobe.path, file)
  if (!m.ok) return { ...base, error: m.error }
  return {
    ...base,
    duration: m.duration,
    durationHuman: m.durationHuman,
    width: m.width,
    height: m.height,
    fps: m.fps,
    aspect: m.aspect,
    sizeMB: m.sizeMB,
    videoCodec: m.videoCodec,
    audioCodec: m.audioCodec,
    hasAudio: m.hasAudio,
    hasSubtitle: m.subtitleStreams.length > 0,
    bitrateKbps: m.bitrateKbps,
    tags: Object.keys(m.tags || {}).length ? m.tags : undefined,
  }
}

/** 解析要蒸哪些视频：给了 video 就一条；给了 dir 就前 top 条 */
function resolveTargets(args, cfg) {
  const one = String(args.video || '').trim()
  if (one) {
    const cand = [one]
    if (!/^[a-zA-Z]:[\\/]/.test(one) && !one.startsWith('/') && !one.startsWith('\\\\')) {
      if (cfg.dir) cand.push(join(cfg.dir, one))
    }
    const hit = cand.find((p) => existsSync(p))
    if (!hit) {
      return {
        error: `找不到这个视频：${one}`,
        hint: cfg.dir ? `也找过配置目录里的同名文件（${cfg.dir}）` : '给绝对路径，或者先用 video_scan 看清目录里有什么',
      }
    }
    let st
    try { st = statSync(hit) } catch (e) { return { error: `读不了：${e?.message ?? e}` } }
    if (!st.isFile()) return { error: `不是文件：${hit}` }
    return { files: [hit] }
  }

  const dir = String(args.dir || cfg.dir || '').trim()
  if (!dir) return { error: '没说蒸哪条：给 video（路径）或 dir（目录）+ top（前几条）', hint: '也可以先用 video_scan 看清单' }
  if (!existsSync(dir)) return { error: `目录不存在：${dir}` }
  const top = Math.max(1, Math.min(10, Math.round(Number(args.top) || 1)))
  const scan = scanDir(dir, { maxVideos: top })
  if (!scan.ok) return { error: scan.error }
  if (!scan.videos.length) return { error: `这个目录里没有视频：${dir}`, hint: '试试 recursive:true，或确认扩展名' }
  return { files: scan.videos.map((v) => v.path) }
}
