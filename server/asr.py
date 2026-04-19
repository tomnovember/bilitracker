"""BiliTracker ASR模块 - 音频下载 + Whisper语音转文字"""
import os
# 必须在所有 huggingface_hub import 之前设置镜像
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 将 CUDA bin 目录加入 DLL 搜索路径（Windows Python 3.8+ 必须用 add_dll_directory）
# 按常见 CUDA 安装路径依次尝试，找到就加；无 GPU 时跳过
for _cuda_ver in ["v12.6", "v12.4", "v12.2", "v12.0", "v11.8", "v13.2"]:
    _cuda_bin = rf"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\{_cuda_ver}\bin\x64"
    if os.path.exists(_cuda_bin):
        try:
            os.add_dll_directory(_cuda_bin)
        except Exception:
            pass
        break

import json
import subprocess
import logging
from datetime import datetime

logger = logging.getLogger("bilitracker.asr")

# 模型名 → HuggingFace repo 映射
_MODEL_REPOS = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3":       "Systran/faster-whisper-large-v3",
    "medium":         "Systran/faster-whisper-medium",
    "small":          "Systran/faster-whisper-small",
    "base":           "Systran/faster-whisper-base",
    "tiny":           "Systran/faster-whisper-tiny",
}

# Whisper模型缓存（按模型名分开缓存）
_whisper_cache: dict = {}


def _get_whisper_model(model_size: str = None):
    """延迟加载faster-whisper模型，按model_size分别缓存"""
    from config import WHISPER_MODEL
    size = model_size or WHISPER_MODEL
    if size not in _whisper_cache:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise RuntimeError("faster-whisper未安装。请执行: pip install faster-whisper")

        # 用 snapshot_download 获取真实本地路径，绕过 Windows symlink 问题
        repo_id = _MODEL_REPOS.get(size, f"Systran/faster-whisper-{size}")
        try:
            from huggingface_hub import snapshot_download
            local_path = snapshot_download(repo_id, local_files_only=False)
            model_arg = local_path
            logger.info(f"模型本地路径: {local_path}")
        except Exception as e:
            logger.warning(f"snapshot_download 失败，回退到模型名: {e}")
            model_arg = size

        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = os.environ.get("WHISPER_COMPUTE", "auto")
        logger.info(f"加载Whisper模型: {size} device={device}")
        try:
            _whisper_cache[size] = WhisperModel(model_arg, device=device, compute_type=compute_type)
        except Exception as e:
            if "cublas" in str(e).lower() or "cuda" in str(e).lower() or device != "cpu":
                logger.warning(f"GPU加载失败({e})，回退到CPU int8")
                _whisper_cache[size] = WhisperModel(model_arg, device="cpu", compute_type="int8")
            else:
                raise
        logger.info(f"Whisper模型 {size} 加载完成")
    return _whisper_cache[size]


def download_audio(bv_id: str, output_dir: str) -> str:
    """用yt-dlp下载B站视频音频，返回音频文件路径"""
    url = f"https://www.bilibili.com/video/{bv_id}"
    # 使用%(ext)s模板，yt-dlp转wav后自动产出 bvid.wav（避免bvid.wav.wav双扩展名问题）
    output_template = os.path.join(output_dir, f"{bv_id}.%(ext)s")
    expected_wav = os.path.join(output_dir, f"{bv_id}.wav")

    # 如果已存在则跳过
    if os.path.exists(expected_wav) and os.path.getsize(expected_wav) > 1000:
        logger.info(f"音频文件已存在: {expected_wav}")
        return expected_wav

    from config import FFMPEG_PATH
    ffmpeg_dir = os.path.dirname(FFMPEG_PATH) if FFMPEG_PATH else None

    cmd = [
        "yt-dlp",
        "--no-warning",
        "-x",                                        # 仅提取音频
        "--audio-format", "wav",                      # 输出wav（Whisper最佳输入）
        "--audio-quality", "0",                       # 最佳质量
        "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",  # 16kHz单声道（Whisper要求；ffmpeg:前缀为新版yt-dlp必须）
        "-o", output_template,
        "--cookies-from-browser", "chrome",           # 使用Chrome的B站cookie
        url
    ]
    if ffmpeg_dir:
        cmd = cmd[:1] + ["--ffmpeg-location", ffmpeg_dir] + cmd[1:]

    logger.info(f"下载音频: {bv_id}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300
        )
        if result.returncode != 0:
            # 如果cookies-from-browser失败，不带cookie重试
            logger.warning(f"带cookie下载失败，尝试不带cookie: {result.stderr[:200]}")
            cmd_no_cookie = [c for c in cmd if c != "--cookies-from-browser" and c != "chrome"]
            result = subprocess.run(
                cmd_no_cookie, capture_output=True, text=True, timeout=300
            )
            if result.returncode != 0:
                raise RuntimeError(f"yt-dlp下载失败: {result.stderr[:500]}")
    except FileNotFoundError:
        raise RuntimeError(
            "yt-dlp未安装。请执行: pip install yt-dlp\n"
            "或从 https://github.com/yt-dlp/yt-dlp 安装"
        )

    # 查找实际产出文件（通常是 bvid.wav）
    if os.path.exists(expected_wav) and os.path.getsize(expected_wav) > 1000:
        logger.info(f"音频下载完成: {expected_wav} ({os.path.getsize(expected_wav)} bytes)")
        return expected_wav

    # fallback：扫描目录找包含bvid的音频文件
    for f in sorted(os.listdir(output_dir)):
        if bv_id in f and f.endswith((".wav", ".m4a", ".webm", ".opus", ".mp3")):
            found = os.path.join(output_dir, f)
            logger.info(f"音频下载完成（fallback）: {found} ({os.path.getsize(found)} bytes)")
            return found

    raise RuntimeError(f"下载完成但找不到音频文件，目录内容: {os.listdir(output_dir)}")


def transcribe_with_model(model, audio_path: str) -> dict:
    """用已加载的模型转写音频，返回 {full_text, timeline_json}"""
    logger.info(f"开始转写: {audio_path}")
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    timeline = []
    texts = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            timeline.append({
                "from": round(seg.start, 2),
                "to": round(seg.end, 2),
                "text": text
            })
            texts.append(text)

    full_text = "".join(texts)
    logger.info(f"转写完成: {len(timeline)}段, {len(full_text)}字, 语言={info.language}, 概率={info.language_probability:.2f}")

    return {
        "full_text": full_text,
        "timeline_json": timeline,
        "source": "whisper",
        "language": info.language,
        "language_prob": round(info.language_probability, 3),
        "duration": round(info.duration, 1),
    }


def transcribe_audio(audio_path: str, model_size: str = None) -> dict:
    """用Whisper转写音频，返回 {full_text, timeline_json}"""
    model = _get_whisper_model(model_size)
    return transcribe_with_model(model, audio_path)


def extract_subtitle_from_audio(bv_id: str, storage_dir: str) -> dict:
    """完整流程：下载音频 → Whisper转写 → 返回字幕数据"""
    # 音频存放在storage_dir/audio/下
    audio_dir = os.path.join(storage_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)

    # 1. 下载音频
    audio_path = download_audio(bv_id, audio_dir)

    # 2. Whisper转写
    result = transcribe_audio(audio_path)

    # 3. 转写完成后删除音频文件（默认删除，可设 WHISPER_KEEP_AUDIO=1 保留）
    if os.environ.get("WHISPER_KEEP_AUDIO", "0") != "1" and os.path.exists(audio_path):
        os.remove(audio_path)
        logger.info(f"已清理音频文件: {audio_path}")

    return result
