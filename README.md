# BiliTracker

> 安静记录B站观看轨迹，构建个人认知数据库。
>
> *Silently track your Bilibili watch history and build a personal knowledge base.*

Chrome 扩展 + 本地 FastAPI 服务 + SQLite，无需账号，数据完全本地。

---

## 功能概览

| 模块 | 功能 |
|------|------|
| **自动采集** | 视频元数据、字幕、观看行为（进度/倍速/来源/连播）静默记录 |
| **AI 总结** | 基于字幕一键生成结构化总结，支持 DeepSeek / Qwen / OpenAI / Gemini 等 |
| **对话问答** | 基于视频内容对话，历史持久化，支持携带观看数据分析 |
| **语音转写** | 无字幕视频用 Whisper 自动生成字幕（本地推理，首次自动下载模型） |
| **统计面板** | 9 项核心指标、UP主/分区 TOP10、24小时热力图、30天趋势、来源分布 |
| **模型对比** | 内置主流模型性能/价格/性价比表格，含 LM Arena ELO 实测分 |

---

## 系统要求

- Windows 10/11（macOS/Linux 理论可用，自启脚本仅限 Windows）
- Python 3.10+
- Chrome / Edge 浏览器
- ffmpeg（ASR 功能需要，可通过 `winget install ffmpeg` 安装）

---

## 安装

### 第一步：Server

```bash
git clone https://github.com/tomnovember/bilitracker.git
cd bilitracker

pip install -r requirements.txt

cd server
python server.py
```

Server 启动后访问 http://localhost:9876 进入 Web 面板。

数据默认存储在 `~/BiliTracker/`，可自定义：

```bash
# Windows
set BILITRACKER_DIR=D:\MyData
python server.py

# macOS / Linux
export BILITRACKER_DIR=/data/bilitracker
python server.py
```

### 第二步：配置 API Key

Web 面板 → **设置** → 填入任意一家服务商的 API Key（总结/对话功能需要）。

支持：DeepSeek、通义千问、豆包、Moonshot、智谱、OpenAI、Google、Anthropic、OpenRouter。

Key 保存在本地 `settings.json`，不会上传。

### 第三步：安装 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 右上角开启**开发者模式**
3. 点击**加载已解压的扩展程序** → 选择项目中的 `extension/` 文件夹
4. 访问任意 B 站视频，点击扩展图标打开侧边栏

### 开机自启（可选，Windows）

```bash
# Task Scheduler（简单）
python install_autostart.py install

# NSSM 系统服务（推荐，崩溃自动重启）
python install_autostart.py service

# 管理
python install_autostart.py status
python install_autostart.py uninstall
```

---

## 语音转写（ASR）

对没有字幕的视频，侧边栏点击**生成字幕**，Server 会自动：

1. 用 yt-dlp 下载音频
2. 用 faster-whisper 本地推理生成字幕
3. 字幕写入数据库供后续总结/对话使用

**首次使用**会自动从 HuggingFace 下载 Whisper 模型（`large-v3-turbo` 约 1.6GB）。

切换模型：

```bash
set WHISPER_MODEL=small          # 小模型，速度快
set WHISPER_MODEL=large-v3-turbo # 默认推荐
set WHISPER_MODEL=large-v3       # 最高精度
```

---

## 三种交互入口

| 入口 | 地址 | 用途 |
|------|------|------|
| **Extension 侧边栏** | 点击扩展图标 | 单视频：总结、对话、状态查看 |
| **Web 面板** | http://localhost:9876 | 全局：视频列表、统计、设置、数据库浏览 |
| **CLI** | `python cli.py` | 命令行：查询、导出、统计 |

### CLI 常用命令

```bash
python cli.py stats              # 统计概览
python cli.py videos             # 最近观看列表
python cli.py search 关键词      # 搜索视频
python cli.py info BV1xxxxxxxxx  # 视频详情
python cli.py chat               # 通用对话（含数据分析）
python cli.py chat BV1xxxxxxxxx  # 基于某视频对话
python cli.py export             # 导出 CSV
python cli.py db                 # 数据库概况
```

---

## 数据库结构

| 表 | 内容 |
|----|------|
| `videos` | 视频元数据、互动数据、AI 总结、用户标注 |
| `watch_events` | 每次观看行为（时间、进度、倍速、来源、连播） |
| `subtitles` | 字幕全文 + 时间轴 JSON |
| `chat_sessions` | 对话会话（绑定视频或通用） |
| `chat_messages` | 对话消息历史 |

---

## 隐私说明

- 所有数据存储在本地，不上传任何服务器
- API Key 保存在本地 `settings.json`，不包含在代码中
- AI 总结/对话时，视频字幕内容会发送给所选 AI 服务商

---

## License

CC BY-NC 4.0 © 2026 唐梦 (TANG Meng)

---

## 致谢

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — 本地语音识别
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 音频下载
- [FastAPI](https://fastapi.tiangolo.com/) — 本地 API 服务
- [LM Arena](https://lmarena.ai/leaderboard) — 模型性能数据来源
