/**
 * lib/install.mjs —— 「装本地转写引擎」这一件事，只做一次、后台做、全过程可追
 * ============================================================================
 * 为什么要专门一个模块：
 *   装 faster-whisper 要 2–5 分钟（venv + pip + 首次下模型 ~500MB）。
 *   **工具调用不能阻塞这么久** ——
 *   所以这里是"点了就返回，装完看状态"的模式：
 *     `video_asr_install` → 起后台 → 立刻回 { started:true, log, hint }
 *     `video_status`      → 看 state.json / 日志尾巴 / 装没装成
 *
 * 几条实践经验：
 *   * `python -m venv` 是最稳的建环境方式（不需要 uv，不需要管理员）；
 *   * pip 按 `pipMirrors` 顺序试，全失败才报错（国内直连 pypi 经常 30 秒超时）；
 *   * **模型也在这里下**（HF_ENDPOINT 走 hf-mirror），否则第一次转写会莫名其妙卡住，
 *     使用者会以为是插件坏了；
 *   * 全程日志进 `$DSH_HOME/video-distill/logs/asr-install.log`，出问题直接看尾巴。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTALL_LOG, MODEL_DIR, LOG_DIR, VENV_DIR, clearVendorCache, ensureDirs, findPython, readJson, venvPython, writeJson,
} from './env.mjs'
import { run } from './media.mjs'

const STATE_FILE = join(LOG_DIR, 'asr-install-state.json')

export function installState() {
  const s = readJson(STATE_FILE, null)
  if (!s || typeof s !== 'object') return { running: false, ok: false, step: 'idle' }
  return s
}

export function installLogTail(n = 60) {
  try {
    const txt = readFileSync(INSTALL_LOG, 'utf8')
    return txt.split(/\r?\n/).slice(-n).join('\n')
  } catch { return '' }
}

export function vendorSnippet() {
  const py = venvPython()
  if (!existsSync(py)) return { ready: false }
  const r = run(py, ['-c', 'import faster_whisper,ctranslate2;print(faster_whisper.__version__)'], { timeout: 60_000 })
  return { ready: r.status === 0, python: py, version: r.status === 0 ? r.stdout.trim() : '', error: r.status === 0 ? '' : (r.stderr || r.error).slice(0, 300) }
}

function appendLog(s) {
  try {
    ensureDirs()
    appendFileSync(INSTALL_LOG, s, 'utf8')
  } catch { /* 日志写不进去不影响安装 */ }
}

function setState(patch) {
  const next = { ...installState(), ...patch, updatedAt: new Date().toISOString() }
  try { writeJson(STATE_FILE, next) } catch { /* 状态写不进去也不致命 */ }
  return next
}

/** 起一个子进程，把 stdout/stderr 全灌进安装日志；返回 exit code（永不抛） */
function spawnLogged(cmd, args, { cwd = LOG_DIR, env = {}, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    appendLog(`\n$ ${cmd} ${args.join(' ')}\n`)
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (e) {
      appendLog(`起不来：${e?.message ?? e}\n`)
      return resolve(1)
    }
    const sink = (b) => appendLog(String(b))
    child.stdout?.on('data', sink)
    child.stderr?.on('data', sink)
    let timer = null
    if (timeout > 0) timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, timeout)
    child.on('error', (e) => { appendLog(`进程错误：${e?.message ?? e}\n`); if (timer) clearTimeout(timer); resolve(1) })
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      appendLog(`\n--- exit ${code} ---\n`)
      resolve(code ?? 1)
    })
  })
}

/**
 * 开始装（或在跑时直接返回"已经在装了"）。
 * @param {object} cfg
 * @param {{ model?: string, downloadModel?: boolean }} opts
 */
export function startInstall(cfg, opts = {}) {
  const cur = installState()
  if (cur.running) {
    return { ok: true, alreadyRunning: true, state: cur, log: INSTALL_LOG, hint: '已经在装了，等日志走完（video_status 能看进度）' }
  }
  const model = String(opts.model || cfg?.modelSize || 'small')
  const downloadModel = opts.downloadModel !== false
  ensureDirs()
  appendLog(`\n\n=== ${new Date().toISOString()} 开始装本地转写引擎（model=${model}）===\n`)
  setState({ running: true, ok: false, step: 'start', model, startedAt: new Date().toISOString(), error: '', ready: false })

  ;(async () => {
    try {
      /* ① 挑一个 ≥3.9 的 python */
      const py = findPython(cfg)
      if (!py.cmd) {
        setState({ running: false, ok: false, step: 'python', error: '这台机器上找不到 ≥3.9 的 Python', tried: py.tried })
        appendLog(`找不到 Python。试过：\n${py.tried.join('\n')}\n`)
        return
      }
      appendLog(`用 ${py.cmd} ${py.args.join(' ')}（${py.version}）\n`)
      setState({ step: 'venv', python: `${py.cmd} ${py.args.join(' ')}`.trim(), pythonVersion: py.version })

      /* ② 建 venv */
      if (!existsSync(venvPython())) {
        const code = await spawnLogged(py.cmd, [...py.args, '-m', 'venv', VENV_DIR], { timeout: 240_000 })
        if (code !== 0 || !existsSync(venvPython())) {
          setState({ running: false, ok: false, step: 'venv', error: `建 venv 失败（exit ${code}）` })
          return
        }
      }
      const vpy = venvPython()

      /* ③ pip install faster-whisper（镜像按顺序试） */
      setState({ step: 'pip' })
      const mirrors = Array.isArray(cfg?.pipMirrors) && cfg.pipMirrors.length
        ? cfg.pipMirrors
        : ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple']
      let code = 1
      for (const m of mirrors) {
        appendLog(`\n--- pip 试镜像 ${m} ---\n`)
        code = await spawnLogged(vpy, [
          '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
          '-i', m, 'faster-whisper',
        ], { timeout: 900_000 })
        if (code === 0) break
      }
      if (code !== 0) {
        setState({ running: false, ok: false, step: 'pip', error: 'pip 装不上（所有镜像都失败了）' })
        return
      }

      /* ④ 验收：能 import 才算数 */
      setState({ step: 'verify' })
      clearVendorCache() // pip 刚装完，别让 2 分钟的旧缓存说"没装"
      const v = vendorSnippet()
      if (!v.ready) {
        setState({ running: false, ok: false, step: 'verify', error: `装完了但 import 不起来：${v.error}` })
        return
      }
      appendLog(`faster-whisper ${v.version} 就绪\n`)

      /* ⑤ 预下模型（可选；不下的话第一次转写会卡在下载上，体验很差） */
      if (downloadModel) {
        setState({ step: 'model', model })
        appendLog(`\n--- 预下模型 ${model}（走镜像 ${cfg?.hfMirror || '默认'}，约 500MB）---\n`)
        const env = {}
        if (cfg?.hfMirror) {
          env.HF_ENDPOINT = cfg.hfMirror
          env.HUGGINGFACE_HUB_BASE_URL = cfg.hfMirror
        }
        /**
         * 🔴 必踩的一脚：新版 huggingface_hub 默认走 **Xet** 存储
         *    （cas-server.xethub.hf.co），镜像站不代理它 ⇒ 401 Unauthorized，
         *    日志里长得像"鉴权问题"，其实是"镜像不支持 Xet"。
         *    关掉它才走普通 HTTP 下载。这条在 2026-10 的 hf-mirror 上实测有效。
         */
        env.HF_HUB_DISABLE_XET = '1'
        env.HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
        const mcode = await spawnLogged(vpy, [
          '-c',
          `from faster_whisper import WhisperModel; m=WhisperModel(${JSON.stringify(model)}, device="cpu", compute_type="int8", download_root=${JSON.stringify(MODEL_DIR)}); print("MODEL_OK")`,
        ], { env, timeout: 1_800_000 })
        if (mcode !== 0) {
          // 模型没下成不算安装失败：引擎已经能跑，第一次转写时还会再试一次
          appendLog('⚠️ 模型预下载没成功（引擎本身是好的，第一次转写会自己再下一次）\n')
          setState({
            running: false, ok: true, ready: true, step: 'done', modelDownloaded: false,
            warning: '引擎装好了，但模型没预下成功；第一次转写可能要多等一会儿',
          })
          return
        }
        appendLog('模型就绪\n')
      }

      setState({ running: false, ok: true, ready: true, step: 'done', modelDownloaded: downloadModel, finishedAt: new Date().toISOString() })
      appendLog(`\n=== ${new Date().toISOString()} 安装完成 ===\n`)
    } catch (e) {
      appendLog(`\n装崩了：${e?.stack ?? e}\n`)
      setState({ running: false, ok: false, step: 'crash', error: String(e?.message ?? e) })
    }
  })()

  return {
    ok: true,
    started: true,
    log: INSTALL_LOG,
    model,
    downloadModel,
    hint: '后台在装（venv → pip → 预下模型，通常 2–5 分钟）。装完 video_status 会显示 ready:true；期间可以先干别的。',
  }
}

/** 环境体检：ffmpeg / python / venv / 模型 / 家目录，一次说清 */
export function envReport(cfg) {
  const py = findPython(cfg)
  const v = vendorSnippet()
  let modelBytes = 0
  try {
    const dir = join(MODEL_DIR)
    if (existsSync(dir)) modelBytes = dirSize(dir)
  } catch { modelBytes = 0 }
  let logBytes = 0
  try { logBytes = existsSync(INSTALL_LOG) ? statSync(INSTALL_LOG).size : 0 } catch { logBytes = 0 }
  return {
    python: { found: !!py.cmd, version: py.version, source: py.source, cmd: py.cmd ? `${py.cmd} ${py.args.join(' ')}`.trim() : '', tried: py.tried },
    venv: { path: VENV_DIR, exists: existsSync(venvPython()), python: venvPython() },
    vendor: v,
    model: { dir: MODEL_DIR, sizeMB: Math.round((modelBytes / 1048576) * 10) / 10, wanted: cfg?.modelSize || 'small', downloaded: modelBytes > 50 * 1048576 },
    install: { state: installState(), logFile: INSTALL_LOG, logBytes, tail: installLogTail(25) },
  }
}

function dirSize(dir) {
  let total = 0
  const walk = (d, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else { try { total += statSync(p).size } catch { /* skip */ } }
    }
  }
  walk(dir, 0)
  return total
}

/** 小工具：确保目录存在（导出给 index 用，少 import 一处） */
export function ensureLogDir() { mkdirSync(LOG_DIR, { recursive: true }) }

/** 手动写一行运行日志（插件侧用） */
export function writeRuntimeLog(line) {
  try {
    ensureDirs()
    appendFileSync(join(LOG_DIR, 'runtime.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch { /* ignore */ }
}
