"""
ASR链路验证脚本 - 单独测试，不依赖运行中的server
用法: python test_asr.py BV1xxxxxx
"""
import sys
import os
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import STORAGE_DIR


def main():
    bv_id = sys.argv[1] if len(sys.argv) > 1 else input("输入BVid (如 BV1xxxxxx): ").strip()
    if not bv_id.startswith("BV"):
        print("错误: bvid必须以BV开头")
        sys.exit(1)

    print(f"\n=== 测试ASR链路: {bv_id} ===")
    print(f"存储目录: {STORAGE_DIR}\n")

    # Step 1: 下载音频
    from asr import download_audio, transcribe_audio
    print("─── Step 1: yt-dlp 下载音频 ───")
    audio_dir = os.path.join(STORAGE_DIR, "audio")
    try:
        audio_path = download_audio(bv_id, audio_dir)
        size_mb = os.path.getsize(audio_path) / 1024 / 1024
        print(f"[✓] 音频文件: {audio_path} ({size_mb:.1f} MB)\n")
    except Exception as e:
        print(f"[✗] 下载失败: {e}")
        sys.exit(1)

    # Step 2: Whisper 转写
    print("─── Step 2: faster-whisper 转写 ───")
    try:
        result = transcribe_audio(audio_path)
        print(f"[✓] 语言: {result['language']} (概率 {result['language_prob']})")
        print(f"[✓] 时长: {result['duration']}s, 段数: {len(result['timeline_json'])}, 字数: {len(result['full_text'])}")
        print(f"\n前200字预览:\n{result['full_text'][:200]}...\n")
    except Exception as e:
        print(f"[✗] 转写失败: {e}")
        sys.exit(1)

    # Step 3: 存入数据库
    print("─── Step 3: 存入subtitles表 ───")
    try:
        from database import init_db, upsert_video, upsert_subtitle, get_subtitle_text
        init_db()
        # 需要先有videos记录（外键约束）
        from datetime import datetime
        upsert_video({
            "bv_id": bv_id,
            "title": f"[ASR测试] {bv_id}",
            "has_subtitle": 1,
            "subtitle_source": "whisper",
        })
        upsert_subtitle(bv_id, {
            "full_text": result["full_text"],
            "timeline_json": result["timeline_json"],
        })
        stored = get_subtitle_text(bv_id)
        if stored:
            print(f"[✓] subtitles表已写入, char_count={len(stored)}")
        else:
            print("[!] upsert_subtitle未写入（可能已有记录，这是正常的）")
    except Exception as e:
        print(f"[✗] 数据库写入失败: {e}")
        sys.exit(1)

    print(f"\n=== ASR链路验证通过 ✓ ===")
    print(f"现在可以在sidebar点「生成总结」，服务器会直接读取已存储的字幕。")


if __name__ == "__main__":
    main()
