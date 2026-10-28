# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-video-distill`（中文名「**视频蒸馏**」）：把「看别人拍的视频、学着写同款文案」做成一条链路 ——
**转写口播 → 抽关键帧 → 数镜头切点 → 十项拆解 → 抽模板 → 写新文案 → 存成 md**。

它**不下载视频**、**不剪辑**、**不发布**。只做"读进来 + 拆开 + 照着写"。

## 帮使用者装的时候，按这个顺序

1. **先体检**（不用装 DSH）：
   ```bash
   node tools/cli.mjs status --verbose     # ffmpeg / 转写 / 目录 / Python
   node tools/selftest.mjs                 # 离线自检，验"插件能不能被宿主装配"
   ```
2. **装插件**：`dsh plugin --profile desktop add link:<本目录绝对路径>`
3. ⚠️ **必须提醒使用者重启一次 DSH** —— bundle 层要重启才组装，不重启插件不生效。
4. 重启后：`video_status` 会自动报「缺什么」。按它的 `next` 一条条补：
   - 缺 ffmpeg → `winget install Gyan.FFmpeg`
   - 缺转写 → `video_asr_install`（本地，离线）或 `video_config` 配 `apiBaseUrl` + `apiKey`（云端）
   - 缺目录 → 问使用者"哪个目录"，然后 `video_config dir=<绝对路径>`

## 用的时候（标准四步，别跳步）

```
video_scan       →  有哪些片子（时长/竖屏/有声/有字幕）—— 先看清再动手
video_distill    →  一条：口播 + 关键帧 + 拼图 + 切点 + 元数据（一次一条）
video_guide      →  拆解十项 + 模板 + 写文案的硬要求（第一次必读）
video_save       →  拆解+模板+文案一次写完再存
```

## 几条实测教训（别再踩）

1. **一次只蒸一条**。整目录全蒸又慢又贵（本地 small 模型 ≈ 1/3 实时）。
   先蒸 1 条看清结构，再决定要不要蒸第 2、3 条做横向对比。
2. **口播没拿到就绝不动笔**。`transcript.ok=false` 时只能就画面下结论，并且必须写明
   「没听到声音」。`how_to_fix` 是写好的，原样转述给使用者。
3. **关键帧要真看**（`read_image` 读 `sheet.jpg`），不要靠文件名/时长猜画面。
   拼图是行优先：左→右、上→下 就是时间顺序，帧号 ↔ 秒数在 `frames[]` 里。
4. **切点数只是参考**。纯色/慢推镜的 scene 分天然偏低（实测 0.21 < 阈值 0.3），
   真人口播换镜一般 >0.4。切点是 0 时不要断言"一镜到底"，说"按检测没有明显换镜"。
5. **字数服从时长**：中文口播按 **5 字/秒**。15 秒 ≈ 70–78 字，30 秒 ≈ 145–155 字。
   超了就是念不完。
6. **钩子三禁**：「大家好」「今天给大家分享」「你是否也曾」。
7. **不抄句子**：连续 8 个字和原片一样就是抄。同一个意思换说法。
8. **不编数据**：原片的数字可以用；要新增就写「（待填：具体数字）」。
9. **缓存在 `work/<名字>-<指纹>/`**，指纹 = 路径+大小+mtime。视频换过就自动失效；
   要强制重跑传 `force=true`。
10. **工具超时**：`video_distill` 是同步的，长视频（>10 分钟）+ 本地 small 模型可能要几分钟。
    遇到长片先 `video_config maxSec=600` 把超长的挡掉，或让使用者知道要等。

## 红线

- 🔴 **插件包目录只读**。配置/缓存/成稿都在 `$DSH_HOME/video-distill/`，别往 `node_modules` 里写。
- 🔴 **零第三方依赖是刻意的**。不要为了省事 `import` 一个 npm 包 —— 桌面版 profile 经常
  一个 `@deepseek-ai/*` 都没有，裸 import 失败会让**整条插件静默不激活**（工具全不出现）。
  需要的东西自己用 `node:*` 写，或者调外部命令行。
- 🔴 **Key 只进 `secret.json`**，不进 `config.json`、不进日志、不进工具返回值（只给打码）。
- 🔴 **永不静默降级**：拿不到就说拿不到，不许拿旧数据凑、不许空字符串冒充"没人说话"。
- 🔴 **定时器/子进程的异常自己兜住** —— 未捕获异常会带走整个宿主进程。

## 仓库结构

- `index.js` —— 宿主半端：`apply(ctx)`、7 个工具、`video_config` 的读写、`video_save` 的落盘
- `lib/env.mjs` —— 家目录/配置/ffmpeg/Python 探测（**所有路径与默认值只有这一处定义**）
- `lib/media.mjs` —— ffprobe 元数据、抽音轨、抽关键帧、拼图、镜头切点
- `lib/asr.mjs` —— 四条转写路（sidecar / embedded / local / api）+ 字幕解析
- `lib/distill.mjs` —— 一条视频的总调度 + 缓存 + `transcript.md` 渲染 + `briefing`
- `lib/install.mjs` —— 本地引擎安装（venv → pip → 预下模型），后台跑、状态可查
- `lib/toolkit.mjs` —— 造「注册表就绪」的工具定义：把扁平参数规格自己编译成 JSON Schema。
  🔴 **别再改回 `defineTool`**：插件侧 `dsh-tools` 的 `parameters` 是**扁平 property map 规格**
  （`parameterSchemaSpecToJsonSchema` → `compilePropertyMap`），传 `{type:'object',properties:{…}}`
  会被当成三个参数名而**静默错**；沙箱侧 `harness.defineTool` 才两种都认。注册表吃的是
  已经转换好的 JSON Schema，所以我们直接产出它，同时不依赖宿主树里有没有 `@deepseek-ai/*`。
- `tools/asr.py` —— faster-whisper 跑一次，stdout 只吐一行 JSON
- `tools/cli.mjs` —— 不开 DSH 的命令行（**也是最快的端到端验证方式**）
- `tools/selftest.mjs` —— 离线自检（随包文件、依赖洁癖、工具规格、假 ctx 真装载，187 项）
- `tools/e2e.mjs` —— 端到端演练（真调 7 个工具：scan → distill → guide → save → 缓存命中）
- `tools/make-test-media.ps1` —— 造测试素材（中文 TTS + 三镜头竖屏 + 一条带同名 srt）
- `prompts/distill.md` —— **拆解与写作章程**（`video_guide` 只读这一份，绝不读外面的设定）
