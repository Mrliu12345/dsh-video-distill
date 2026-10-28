# 装给别人看的一页说明

> 这一页是给**拿到链接就想装的人**看的。你可以直接把它整段发给对方，或者让他看这个文件。

## 最快的一条命令

DSH 里装插件走 pnpm，所以给一个 Git 源的地址就行：

```
github:Mrliu12345/dsh-video-distill
```

**图形界面版**（不用命令行）：
打开 DSH → **设置 → 插件 → 添加** → 把这行粘进去 → 确定 → **重启 DSH**。

**命令行版**：

```powershell
dsh plugin --profile desktop add github:Mrliu12345/dsh-video-distill
# 然后重启 DSH
```

⚠️ **重启是必须的**：插件要挂进 loader 的 bundle 层，不重启不会出现工具。

## 连不上 GitHub 的话（国内网络常见）

`github:` 这种方式在安装时要用 pnpm 去 git clone，代理没配好就会卡在
`Failed to connect to github.com:443`。改用**本地目录**装，绕开这一步：

```powershell
# 1. 用任意方式把仓库弄到本地（浏览器下 zip、GitHub Desktop、或者 git clone）
git clone https://github.com/Mrliu12345/dsh-video-distill.git D:\dsh-video-distill

# 2. 以 link 方式装进 profile（改代码立刻生效，不用重装）
dsh plugin --profile desktop add link:D:\dsh-video-distill

# 3. 重启 DSH
```

**连 `dsh` 命令都没有**（桌面版精简安装可能是这样）时，手动两步：

```powershell
# ① 让 profile 认得到插件
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-video-distill" `
  -Target "D:\dsh-video-distill"

# ② 在 $env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml 末尾加两行：
# - id: video-distill
#   name: dsh-video-distill

# ③ 重启 DSH
```

## 装之前先确认这台机器有什么

| 需要 | 怎么查 | 没有怎么办 |
|---|---|---|
| **DSH 桌面版/Web 版** | 已经在用了就行 | — |
| **Node ≥ 22** | `node -v` | DSH 自带运行时，一般不用单独装 |
| **ffmpeg + ffprobe** | `ffmpeg -version` | `winget install Gyan.FFmpeg`；或装完在插件配置里写 `ffmpegPath` |
| **Python ≥ 3.9**（可选） | `py -0p` | 只有"本地语音转写"需要；不用本地转写可以不装 |

## 装完第一件事：让它知道自己能怎么转写

插件不会偷偷替你选。装完在对话里说一句 **「体检」**（或直接问"你能用了吗"），
它会调 `video_status` 报三件事：ffmpeg 在不在、转写有没有着落、默认目录有没有设。

没有转写能力时，它**只能看画面**（关键帧里的字幕、构图、出镜方式），听不到口播 —— 会把这件事说出来，不会瞎编。两条路补上：

1. **离线（推荐）**：说「装一下本地转写」→ 后台装 faster-whisper + 模型（约 500MB，2–5 分钟），之后永久离线可用。
2. **在线**：给一个兼容 OpenAI 的转写接口 —— 「我有个转写接口，地址是 xxx，key 是 xxx」，
   它会把 key 存进 `secret.json`（不进日志、不回显）。

## 然后用一句话就能开工

> 「`D:\videos\某某` 里有一些视频，看看人家怎么做的，给我写几条同款文案。」

它会：扫目录 → 挑一条拆（口播转写 + 关键帧 + 拼图 + 镜头切点）→ 按手册做十项拆解 →
抽一个可复用模板 → 写 3–5 条同款文案 → 存成 md 告诉你路径。

产物都在 `%USERPROFILE%\.dsh\video-distill\`：
`work\<视频名>-<指纹>\`（每条视频的材料）、`out\<日期>\`（拆解和文案）、`logs\`。

## 四件最容易卡住的事

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 发完消息没反应、工具不出现 | 没重启 DSH | 重启一次 |
| 「口播没拿到」 | 没 ffmpeg / 没转写 | 说「体检」，按它给的修法补 |
| 第一次转写卡很久 | 在下载模型（~500MB） | 等着；`video_status` 能看进度 |
| 说「切点是 0」 | 一镜到底，或纯色/慢推镜分数低 | 属正常；真觉得漏检就调 `sceneThreshold` |

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-video-distill
# 手动装的就删掉 junction + cordis.patch.yml 里那两行
# 运行数据在 %USERPROFILE%\.dsh\video-distill\，想清干净就整个目录删掉
```

---

## For English readers

`dsh-video-distill` is a plugin for **DeepSeek Harness (DSH)**. It turns a folder of
short videos into a reusable script template: transcription (via sidecar subtitles,
embedded subtitles, local faster-whisper, or any OpenAI-compatible
`/v1/audio/transcriptions` endpoint), keyframes, scene-cut timing, then a structured
breakdown and new scripts in the same style.

```powershell
# install (needs git + network to GitHub)
dsh plugin --profile desktop add github:Mrliu12345/dsh-video-distill
# restart DSH — required, the bundle layer is assembled at startup
```

Requirements: Node ≥ 22 (bundled with DSH), **ffmpeg/ffprobe**, optionally Python ≥ 3.9
for the offline transcription engine. No npm dependencies; everything runtime lives in
`%USERPROFILE%\.dsh\video-distill\`, never inside the plugin folder.
