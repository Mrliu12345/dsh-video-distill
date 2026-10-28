# dsh-video-distill · 视频蒸馏（DSH 插件）

> 你说：「`D:\videos\口播样例` 里有一些视频，看看人家怎么做的，给我写几条同款文案。」
> 它会：**读视频 → 转写口播 → 抽关键帧 → 数镜头切点 → 拆成结构模板 → 按模板写新文案**。

**想直接装？** `github:Mrliu12345/dsh-video-distill` —— 粘到 DSH「设置 → 插件 → 添加」，重启。
详细步骤（含连不上 GitHub 时的替代装法、装完要补什么）：**[INSTALL.md](INSTALL.md)**。

---

## 它到底做了什么

一条视频被"拆开"成四叠材料，交给 DSH 的模型去理解：

| 材料 | 从哪来 | 模型拿它干什么 |
|---|---|---|
| **口播全文 + `[mm:ss]` 时间轴 + 语速** | 同名字幕 / 内嵌字幕 / 本地 faster-whisper / 兼容 OpenAI 的转写 API | 拆钩子、拆结构、学语言指纹 |
| **关键帧 6 张 + 一张拼图** | ffmpeg 均匀抽帧（避开片头片尾） | 看构图/字幕样式/出镜方式/BGM 情绪 |
| **镜头切点时间表** | `scene` 检测 | 判断节奏是"快剪"还是"长镜头" |
| **元数据** | ffprobe | 时长、竖屏横屏、帧率、码率、有没有人声 |

然后按插件自带的手册（`prompts/distill.md`）做十项拆解 → 抽出一个**可复用模板** → 生成 3 条**故意不同**的同款文案（同骨架 / 同钩子换骨架 / 同人群换切口）。

## 装

```powershell
# 1. 装进当前 profile（link 方式：改代码立刻生效，不用重装）
#    <本目录> = 你 clone 下来的这个仓库的绝对路径
dsh plugin --profile desktop add link:<本目录>

# 2. ⚠️ 必须重启一次 DSH（bundle 层要重启才组装，不重启插件不生效）
```

重启后在对话里直接说人话就行，不用记工具名：

> 「`D:\videos\样例` 里有两个视频，先看看有什么，然后挑一条拆给我看，再写三条同款文案。」

**没有 `dsh` CLI 时**，两步手动装：

```powershell
# 1. 让 profile 认得到插件（junction 或整个目录复制过去）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-video-distill" `
  -Target "<本目录的绝对路径>"

# 2. profile 的 cordis.patch.yml 末尾追加一条
# - id: video-distill
#   name: dsh-video-distill
```

装完想确认插件真的活了，跑这两条（不依赖 DSH）：

```powershell
node tools/selftest.mjs     # 187 项：导出、工具 schema、依赖洁癖、假 ctx 真装载
node tools/e2e.mjs <一个放视频的目录>   # 真调 7 个工具跑一遍
```

## 依赖

| 依赖 | 必须? | 说明 |
|---|---|---|
| **ffmpeg + ffprobe** | ✅ 必须 | 抽音轨/抽帧/数切点全靠它。`winget install Gyan.FFmpeg`，或在配置里写 `ffmpegPath`。插件会自动在 PATH 和几个常见安装位置找。 |
| **转写** | ✅ 必须（否则只能看画面） | 四条路任选，见下。 |
| Python ≥ 3.9 | 可选 | 只有"本地转写"需要；插件会自己建 venv，不动系统 Python。 |
| Node ≥ 22 | ✅ | DSH 本身的要求。 |

### 转写的四条路（`backend=auto` 按顺序试）

1. **sidecar** — 视频旁边有同名 `.srt/.vtt/.ass/.json`。最快最准（人写的），零依赖。
2. **embedded** — 字幕压在容器里（mkv/mp4 常见），ffmpeg 一条命令抽出来。
3. **local** — 本地 `faster-whisper`。**一次装好，永久离线**：
   在对话里说「装一下本地转写」，或 `node tools/cli.mjs asr-install --wait`。
   默认 `small` 模型（中文口播够用，约 500MB，装完整套 ~1.5GB）。
4. **api** — 任何兼容 OpenAI `/v1/audio/transcriptions` 的服务（硅基流动、阿里、本地 whisper-server 都行）：

```js
// 在对话里说，或直接改 $DSH_HOME/video-distill/config.json
{ "apiBaseUrl": "https://api.siliconflow.cn/v1", "apiModel": "FunAudioLLM/SenseVoiceSmall" }
```
Key 存 `$DSH_HOME/video-distill/secret.json`（工具只写不读，返回值里是打码的），也可以用环境变量 `DSH_ASR_KEY`。

🔴 **四条都不通时它会明说「口播没拿到」并给出修法**，绝不给空文本 —— 那会让模型对着空气编文案。

## 用（对话示例）

```
你：D:\videos\口播样例 里有些视频，先看看有什么
DSH：video_scan → 2 条，一条 20 秒竖屏有声，一条 16 秒竖屏带字幕

你：把带字幕那条拆给我看
DSH：video_distill + video_guide → 十项拆解 + 可复用模板（读完还要 read_image 看拼图）

你：照这个模子写三条文案，存下来
DSH：video_save → out/2025-xx-xx/<标题>.md
```

产出的文件：

```
$DSH_HOME/video-distill/
├── config.json                 配置（改了就生效，不用重启）
├── secret.json                 转写接口的 Key（不进日志）
├── work/<视频名>-<指纹>/        每条视频的材料
│   ├── transcript.md           ⭐ 带时间轴的口播（模型主要读这个）
│   ├── transcript.json         逐段起止时间
│   ├── meta.json               ffprobe 元数据
│   ├── frames/frame-01.jpg…    关键帧
│   ├── sheet.jpg               关键帧拼图
│   └── bundle.json             索引（下次命中缓存）
├── out/<日期>/<标题>.md         ⭐ 拆解 / 文案成稿
└── logs/                       运行日志 + 安装日志
```

## 配置

改配置不用编辑文件，直接说就行（模型会调 `video_config`）：

| 项 | 默认 | 说明 |
|---|---|---|
| `dir` | 空 | 默认视频目录 |
| `backend` | `auto` | `auto/sidecar/embedded/local/api/none` |
| `language` | `zh` | 转写语言 |
| `modelSize` | `small` | 本地模型：`tiny/base/small/medium/large-v3` |
| `frames` | `6` | 每条视频抽几张关键帧（1–16） |
| `sceneDetect` | `true` | 数不数镜头切点 |
| `sceneThreshold` | `0.3` | 切点阈值（越大越保守） |
| `outDir` | 空 | 成稿目录（默认 `$DSH_HOME/video-distill/out`） |
| `apiBaseUrl` / `apiModel` | 空 / `whisper-1` | 云端转写 |
| `maxVideos` | `20` | 一次扫目录的上限（防误扫整盘） |
| `minSec` / `maxSec` | `3` / `1800` | 太短太长的不看 |
| `ffmpegPath` / `ffprobePath` / `pythonPath` | 空 | 自动找不到时手动指 |

## 命令行（不开 DSH 也能用，也是自测入口）

```powershell
node tools/cli.mjs status --verbose           # 体检：ffmpeg / 转写 / 目录 / Python
node tools/cli.mjs scan D:\videos\样例        # 清单
node tools/cli.mjs distill D:\videos\a.mp4    # 拆一条（--force 重跑，--json 拿原始结果）
node tools/cli.mjs guide                      # 手册原文
node tools/cli.mjs asr-install --wait         # 装本地转写并等它装完
node tools/selftest.mjs                       # 离线自检（187 项，不联网）
node tools/e2e.mjs D:\videos\样例              # 端到端演练：真调 7 个工具跑一遍
```

## 常见问题

**「口播没拿到」** → `node tools/cli.mjs status` 看两件事：ffmpeg 在不在、`local.ok` / `api.ok`。缺什么补什么。

**切点数是 0，但明明有换镜** → 把 `sceneThreshold` 调到 `0.2`；纯色/慢推镜的 scene 分天然偏低。

**第一次转写卡住很久** → 在下载模型（约 500MB）。`asr-install` 默认会预下；如果当时没下成，第一次转写会自己再下一次。看 `logs/asr-install.log`。

**视频有字幕但抽不出来** → 硬字幕（烧在画面里的字）不是字幕流，抽不出来；那是"看画面"的事，模型靠关键帧读。

**磁盘占用** → 每条视频的材料 1–3MB（帧 + 拼图）。清理：删 `$DSH_HOME/video-distill/work/` 里对应目录即可。

## 设计上的三条自我约束

1. **零第三方依赖**：`dependencies` 是空的，连 `@deepseek-ai/dsh-tools` 都不用。桌面版 profile
   经常一个 `@deepseek-ai/*` 都没有，裸 import 会让整条插件静默不激活（工具全不出现）。
   工具定义自己造（`lib/toolkit.mjs`：扁平参数规格 → JSON Schema）。
2. **插件包只读**：一切运行数据在 `$DSH_HOME/video-distill/`，升级/重装不丢。
3. **不编内容**：转写/抽帧失败都如实报告 + 给修法，且失败原因**一条条摊开**（不是一句套话）；
   `video_distill` 返回值里带 `briefing` 告诉模型"这次哪些材料可用、哪些不可用"。

## 许可

MIT
