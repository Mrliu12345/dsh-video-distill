#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/asr.py —— 本地语音转写（faster-whisper），只往 stdout 打一行 JSON
============================================================================
为什么要单独一个脚本：
  * faster-whisper 是 Python 生态的东西（CTranslate2），Node 这边没有等价物；
  * 放进独立进程 ⇒ 模型崩了/吃满内存也不会把 DSH 宿主带下去；
  * **进度全打进 stderr**，stdout 只留最后一行 JSON —— 调用方 `split('\\n')` 找 `{` 就行，
    不用解析任何花哨的日志格式。

输出（成功）：
  {"ok":true,"language":"zh","duration":12.3,"model":"small","segments":[{"start":0.0,"end":2.1,"text":"…"}],"text":"…"}
输出（失败）：
  {"ok":false,"error":"…","detail":"…"}

用法：
  <venv>/python asr.py audio.wav --model small --language zh --model-dir <dir> --mirror https://hf-mirror.com
"""
import argparse
import json
import os
import sys
import time

# 🔴 Windows 上 python 往管道写中文默认走系统代码页（cp936/GBK），调用方按 utf8 解码就会变成
#    `????????`。这里直接把两个流钉成 utf-8，比任何外部环境变量都可靠。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001  （老 python 没有 reconfigure 就算了）
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="zh", help="zh / en / ja / auto")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--mirror", default="")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--initial-prompt", default="")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        emit({"ok": False, "error": "音频文件不存在：%s" % args.audio})
        return 0

    # ⚠️ 必须在 import faster_whisper **之前**设 HF_ENDPOINT：
    #    huggingface_hub 在导入时就把 endpoint 读进常量了，之后再改是没用的。
    if args.mirror:
        os.environ.setdefault("HF_ENDPOINT", args.mirror)
        os.environ.setdefault("HUGGINGFACE_HUB_BASE_URL", args.mirror)
    # 镜像站不代理 Xet 存储（cas-server.xethub.hf.co）⇒ 401，必须关掉走普通 HTTP
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

    try:
        from faster_whisper import WhisperModel  # noqa: WPS433（延迟导入，报错好懂）
    except Exception as e:  # noqa: BLE001
        emit({
            "ok": False,
            "error": "faster-whisper 没装好（%s）" % type(e).__name__,
            "detail": str(e)[:400],
        })
        return 0

    t0 = time.time()
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=(args.model_dir or None),
        )
    except Exception as e:  # noqa: BLE001
        emit({
            "ok": False,
            "error": "模型加载失败（%s）：多半是下载不通或模型名不对" % type(e).__name__,
            "detail": str(e)[:600],
            "hint": "把 mirror 设成能通的地址（默认 hf-mirror.com），或先用更小的模型（tiny/base）试一次。",
        })
        return 0

    load_sec = round(time.time() - t0, 1)
    log("模型 %s 就绪（%.1fs），开始转写 %s" % (args.model, load_sec, os.path.basename(args.audio)))

    language = None if (args.language or "").lower() in ("", "auto") else args.language
    prompt = args.initial_prompt
    if not prompt and (language or "zh") == "zh":
        # 中文口播不加提示词会缺标点、断句也碎；这一句实测有用
        prompt = "以下是普通话短视频口播，请使用标点符号。"

    try:
        segments, info = model.transcribe(
            args.audio,
            language=language,
            beam_size=args.beam,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
        )
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": "转写失败（%s）" % type(e).__name__, "detail": str(e)[:600]})
        return 0

    out = []
    try:
        for s in segments:  # 生成器：真正干活发生在这里
            txt = (s.text or "").strip()
            if not txt:
                continue
            out.append({"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": txt})
            if len(out) % 20 == 0:
                log("… 已转写 %d 段（%.0fs）" % (len(out), time.time() - t0))
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": "转写中断（%s）" % type(e).__name__, "detail": str(e)[:600], "segments": out})
        return 0

    text = "".join(s["text"] for s in out).strip()
    if not text:
        emit({"ok": False, "error": "这个视频里没识别出人声（可能只有音乐/环境音）"})
        return 0

    emit({
        "ok": True,
        "language": getattr(info, "language", "") or (language or ""),
        "duration": round(float(getattr(info, "duration", 0) or 0), 2),
        "model": args.model,
        "elapsed": round(time.time() - t0, 1),
        "segments": out,
        "text": text,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
