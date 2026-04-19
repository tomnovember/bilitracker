"""BiliTracker 配置"""
import os

# 版本号 - 更新代码时同步修改这里和manifest.json
VERSION = "1.2.0"

# 存储路径：数据库、settings.json、音频缓存均在此目录
# 可通过环境变量 BILITRACKER_DIR 自定义，默认放在用户主目录下的 BiliTracker 文件夹
_default_dir = os.path.join(os.path.expanduser("~"), "BiliTracker")
STORAGE_DIR = os.environ.get("BILITRACKER_DIR", _default_dir)

# 数据库文件路径
DB_PATH = os.path.join(STORAGE_DIR, "bilitracker.db")

# Server配置
HOST = "127.0.0.1"
PORT = 9876

# DeepSeek API 默认配置（可在面板→设置中配置，无需重启）
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = "deepseek-chat"

# Whisper模型大小：tiny(39M)/base(74M)/small(244M)/medium(769M)/large-v3(3GB)/large-v3-turbo(1.6GB,推荐)
# 首次使用时自动从 HuggingFace 下载到本地缓存
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")

# ffmpeg路径（ASR音频下载需要）
# 默认使用系统 PATH 中的 ffmpeg；可通过环境变量 FFMPEG_PATH 指定完整路径
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
