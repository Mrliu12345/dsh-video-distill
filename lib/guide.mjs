/**
 * lib/guide.mjs —— 把插件自带的蒸馏手册读出来（**只读自己包里那一份**）
 * ============================================================================
 * 规矩跟 dsh-douyin-scroll 学：一个插件只读自己带的设定，
 * 绝不读工作区/别的插件目录里的 AGENTS.md —— 否则两边的话术会串。
 * 这里只认 `prompts/distill.md`，按 mtime 缓存，改了立刻生效。
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_DIR } from './env.mjs'

export const GUIDE_FILE = join(PLUGIN_DIR, 'prompts', 'distill.md')

let cache = { mtime: -1, text: '' }

export function guideText() {
  if (!existsSync(GUIDE_FILE)) {
    return {
      ok: false,
      path: GUIDE_FILE,
      text: '',
      error: '插件包里缺 prompts/distill.md（安装不完整？）',
    }
  }
  try {
    const mtime = statSync(GUIDE_FILE).mtimeMs
    if (cache.mtime !== mtime) {
      cache = { mtime, text: readFileSync(GUIDE_FILE, 'utf8') }
    }
    return { ok: true, path: GUIDE_FILE, text: cache.text }
  } catch (e) {
    return { ok: false, path: GUIDE_FILE, text: '', error: String(e?.message ?? e) }
  }
}
