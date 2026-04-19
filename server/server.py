"""BiliTracker Local Server"""
import sys
import os

# 确保能import同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uvicorn
import asyncio

from config import HOST, PORT, STORAGE_DIR, DB_PATH
from database import (init_db, upsert_video, insert_watch_record, upsert_subtitle,
                      get_video, get_subtitle_text, update_summary, update_ai_tags,
                      upsert_ganghuo, backfill_ganghuo,
                      get_stats, get_extended_stats,
                      get_watch_records, set_watch_record_excluded, delete_watch_record,
                      set_video_excluded, delete_video_completely,
                      create_chat_session, add_chat_message, get_chat_sessions, get_chat_messages, delete_chat_session)


app = FastAPI(title="BiliTracker", version="1.0")


_PROVIDER_BASE_URLS = {
    "deepseek":  "https://api.deepseek.com/v1",
    "qwen":      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "doubao":    "https://ark.volcengine.com/api/v3",
    "moonshot":  "https://api.moonshot.cn/v1",
    "zhipu":     "https://open.bigmodel.cn/api/paas/v4",
    "openai":    "https://api.openai.com/v1",
    "google":    "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
    "openrouter":"https://openrouter.ai/api/v1",
}

def _get_api_cfg(provider=None):
    """读取 API 配置：按 provider 分别存储，回退旧扁平格式，最终回退 config.py"""
    import json as _j
    from config import DEEPSEEK_API_KEY as _KEY, DEEPSEEK_BASE_URL as _BASE
    p = os.path.join(STORAGE_DIR, "settings.json")
    if os.path.exists(p):
        try:
            with open(p, 'r', encoding='utf-8') as f:
                s = _j.load(f)
            prov = provider or s.get('default_provider', 'deepseek')
            # 新格式：providers[prov]
            pcfg = s.get('providers', {}).get(prov, {})
            key  = pcfg.get('api_key') or ''
            base = pcfg.get('api_base_url') or ''
            # 旧格式兼容（扁平 api_key/api_base_url，仅当新格式为空时读）
            if not key:  key  = s.get('api_key') or ''
            if not base: base = s.get('api_base_url') or ''
            # config.py 兜底（仅 deepseek）
            if prov == 'deepseek':
                key  = key  or _KEY
                base = base or _BASE
            if not base:
                base = _PROVIDER_BASE_URLS.get(prov, '')
            return key, base
        except Exception:
            pass
    return _KEY, _BASE

# 允许Extension跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*", "https://www.bilibili.com"],
    allow_methods=["*"],
    allow_headers=["*"],
)

import traceback
import logging
_logger = logging.getLogger("bilitracker")

@app.middleware("http")
async def log_exceptions(request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        _logger.error(f"Unhandled exception on {request.method} {request.url.path}:\n{traceback.format_exc()}")
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=500, content={"detail": str(e)})


# ──────────────────────────────────────
# 数据模型
# ──────────────────────────────────────

class VideoData(BaseModel):
    bv_id: str
    av_id: Optional[str] = None
    title: str = ""
    description: Optional[str] = None
    cover_url: Optional[str] = None
    duration: Optional[int] = None
    pub_date: Optional[str] = None
    up_id: Optional[str] = None
    up_name: Optional[str] = None
    up_fans_count: Optional[int] = None
    zone_primary: Optional[str] = None
    zone_secondary: Optional[str] = None
    tags: list[str] = []
    total_parts: int = 1
    view_count: Optional[int] = None
    danmaku_count: Optional[int] = None
    like_count: Optional[int] = None
    coin_count: Optional[int] = None
    favorite_count: Optional[int] = None
    share_count: Optional[int] = None
    reply_count: Optional[int] = None
    has_subtitle: int = 0
    subtitle_source: Optional[str] = None
    subtitle_lang: Optional[str] = None


class SubtitleData(BaseModel):
    full_text: Optional[str] = None
    timeline_json: Optional[list] = None


class WatchData(BaseModel):
    bv_id: str
    opened_at: str
    closed_at: Optional[str] = None
    duration_sec: Optional[int] = None
    part_number: int = 1
    part_title: Optional[str] = None
    play_progress: Optional[float] = None
    play_seconds: Optional[int] = None
    completed: int = 0
    max_speed: float = 1.0
    speed_changes: list = []
    is_fullscreen: int = 0
    is_autoplay: int = 0
    autoplay_session: Optional[str] = None
    autoplay_index: Optional[int] = None
    referrer_url: Optional[str] = None
    referrer_type: Optional[str] = None
    search_keyword: Optional[str] = None
    tab_visible_sec: Optional[int] = None
    snapshot_views: Optional[int] = None
    snapshot_likes: Optional[int] = None
    screen_width: Optional[int] = None
    screen_height: Optional[int] = None


class RecordPayload(BaseModel):
    video: VideoData
    subtitle: Optional[SubtitleData] = None
    watch: WatchData


class SummarizeRequest(BaseModel):
    bv_id: str
    model: str = "deepseek-chat"
    whisper_model: str = "large-v3-turbo"
    force: bool = False  # True = 跳过缓存，强制重新生成


# ──────────────────────────────────────
# API 端点
# ──────────────────────────────────────

@app.post("/api/record")
async def record(payload: RecordPayload):
    """接收Extension上报的视频数据和观看记录"""
    bv_id = upsert_video(payload.video.model_dump())

    if payload.subtitle and payload.subtitle.full_text:
        upsert_subtitle(bv_id, payload.subtitle.model_dump())

    watch_id = insert_watch_record(payload.watch.model_dump())

    return {"status": "ok", "bv_id": bv_id, "watch_id": watch_id}


@app.post("/api/summarize")
async def summarize(req: SummarizeRequest):
    """对指定视频生成AI总结（V1.3 - 流式进度反馈）"""
    import json as _json
    import httpx
    from fastapi.responses import StreamingResponse
    from config import STORAGE_DIR

    def _prog(msg: str):
        return f"data: {_json.dumps({'progress': msg}, ensure_ascii=False)}\n\n"

    def _err(msg: str):
        return f"data: {_json.dumps({'error': msg}, ensure_ascii=False)}\n\n"

    async def stream_summary():
        # 1. 查视频（不强制要求在DB中）
        try:
            video = get_video(req.bv_id)
        except Exception as e:
            yield _err(f"数据库查询失败: {e}"); return
        if not video:
            video = {"title": req.bv_id, "up_name": "", "duration": 0, "summary": None}

        # 1b. 已有总结且非强制 → 直接返回缓存（流式）
        existing_summary = video.get("summary")
        if existing_summary and not req.force:
            chunk_size = 50
            for i in range(0, len(existing_summary), chunk_size):
                yield f"data: {_json.dumps({'delta': existing_summary[i:i+chunk_size]}, ensure_ascii=False)}\n\n"
                await asyncio.sleep(0)
            yield f"data: {_json.dumps({'done': True, 'cached': True}, ensure_ascii=False)}\n\n"
            return

        # 2. 取字幕
        try:
            subtitle_text = get_subtitle_text(req.bv_id)
        except Exception as e:
            yield _err(f"字幕读取失败: {e}"); return

        # 3. 无字幕 → ASR流程（带进度）
        if not subtitle_text:
            loop = asyncio.get_event_loop()
            try:
                from asr import download_audio, _get_whisper_model, transcribe_with_model
                audio_dir = os.path.join(STORAGE_DIR, "audio")
                os.makedirs(audio_dir, exist_ok=True)

                # 3a. 下载音频
                yield _prog("正在下载音频（可能需要 1-3 分钟）...")
                try:
                    audio_path = await loop.run_in_executor(None, download_audio, req.bv_id, audio_dir)
                except RuntimeError as e:
                    yield _err(str(e)); return

                # 3b. 加载模型
                yield _prog(f"正在加载 Whisper 模型 [{req.whisper_model}]...")
                try:
                    model = await loop.run_in_executor(None, _get_whisper_model, req.whisper_model)
                except Exception as e:
                    yield _err(f"模型加载失败: {e}"); return

                # 3c. 转写
                yield _prog("正在转写音频...")
                try:
                    result = await loop.run_in_executor(None, transcribe_with_model, model, audio_path)
                except RuntimeError as e:
                    yield _err(str(e)); return

                if not result or not result.get("full_text"):
                    yield _err("转写完成但未获取到文字内容"); return

                subtitle_text = result["full_text"]
                char_count = len(subtitle_text)
                yield _prog(f"转写完成，共 {char_count} 字，正在生成总结...")

                if os.environ.get("WHISPER_KEEP_AUDIO", "0") != "1" and os.path.exists(audio_path):
                    os.remove(audio_path)

                # 确保视频记录存在（满足外键约束）
                if not get_video(req.bv_id):
                    upsert_video({"bv_id": req.bv_id, "title": req.bv_id, "has_subtitle": 1, "subtitle_source": "whisper"})
                upsert_subtitle(req.bv_id, {
                    "full_text": result["full_text"],
                    "timeline_json": result.get("timeline_json", []),
                })

            except Exception as e:
                yield _err(f"ASR 失败: {e}"); return
        else:
            yield _prog("已有字幕，正在生成总结...")

        # 4. 生成总结
        DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL = _get_api_cfg()
        if not DEEPSEEK_API_KEY:
            yield _err("请设置 API Key（在面板→设置中配置）"); return

        max_chars = 100000
        if len(subtitle_text) > max_chars:
            subtitle_text = subtitle_text[:max_chars] + "\n\n[字幕过长，已截断]"

        def _fmt_dur(s):
            h, m = divmod(s, 3600); m, sec = divmod(m, 60)
            return f"{h}小时{m}分钟" if h > 0 else f"{m}分钟{sec}秒"

        prompt = f"""你是信息提炼专家，从视频字幕中提炼结构化知识。

严格要求：
1. 只输出合法JSON，不加任何markdown包裹（不加```json或其他标记）
2. 忽略所有广告、恰饭、推广、赞助内容，不在总结中提及
3. 禁止出现"本视频介绍了..."等废话，直接给实质内容
4. 干货每条必须含具体信息（数字/事实/方法/对比），禁止模糊表述

输出以下JSON结构（严格按此格式，字段名用中文）：
{{
  "概述": "2-3句话，说清视频主题和内容方向，让没看过的人能快速了解",
  "详述": "视频讲了什么，完整叙述主要内容脉络，不省略重要细节，按内容逻辑分段，每段之间用\\n分隔",
  "结论": ["核心发现/观点/答案，直接说结论，1-3条"],
  "干货": [
    {{"类型": "数据|事实|观点|方法|案例|工具", "内容": "具体内容，含数字或细节"}}
  ],
  "建议": ["直接可操作的建议，无则空数组[]"],
  "标签": ["3-5个主题标签，简短，适合跨视频检索"]
}}

---
视频标题：{video['title']}
UP主：{video['up_name'] or ''}　时长：{_fmt_dur(video['duration'] or 0)}

字幕：
{subtitle_text}"""

        full = []
        try:
            summary_model = "deepseek-chat"
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST", f"{DEEPSEEK_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                    json={"model": summary_model, "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 3000, "temperature": 0.3, "stream": True},
                ) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        try:
                            err_msg = _json.loads(body).get("error", {}).get("message", body.decode())
                        except Exception:
                            err_msg = body.decode()
                        yield _err(f"DeepSeek API 错误: {err_msg}"); return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "): continue
                        chunk = line[6:]
                        if chunk == "[DONE]": break
                        try:
                            delta = _json.loads(chunk)["choices"][0]["delta"].get("content", "")
                        except Exception:
                            continue
                        if delta:
                            full.append(delta)
                            yield f"data: {_json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield _err(str(e)); return

        summary_text = "".join(full)
        # 解析 JSON，提取 ai_tags 一并保存
        ai_tags, ganghuo = [], []
        try:
            parsed = _json.loads(summary_text)
            ai_tags = parsed.get("标签", [])
            ganghuo = parsed.get("干货", [])
        except Exception:
            pass
        update_summary(req.bv_id, summary_text, req.model, ai_tags if ai_tags else None)
        if ganghuo:
            upsert_ganghuo(req.bv_id, ganghuo)
        yield f"data: {_json.dumps({'done': True}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream_summary(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/tag_video")
async def tag_video(req: dict):
    """为视频生成 AI 标签（轻量，不生成完整总结）"""
    import json as _json
    import httpx
    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL = _get_api_cfg()

    bv_id = req.get("bv_id")
    if not bv_id:
        raise HTTPException(400, "需要 bv_id")

    video = get_video(bv_id)
    if not video:
        raise HTTPException(404, "视频不存在")

    # 已有结构化总结 → 直接从 summary 里提取标签
    existing = video.get("summary", "")
    if existing:
        try:
            parsed = _json.loads(existing)
            tags = parsed.get("标签", [])
            if tags:
                update_ai_tags(bv_id, tags)
                return {"tags": tags, "source": "summary"}
        except Exception:
            pass

    # 否则用标题+简介+字幕前2000字生成标签
    subtitle_text = get_subtitle_text(bv_id) or ""
    context = f"视频标题：{video['title']}\nUP主：{video.get('up_name','')}"
    if video.get("description"):
        context += f"\n简介：{video['description'][:500]}"
    if subtitle_text:
        context += f"\n字幕节选：{subtitle_text[:2000]}"

    prompt = f"""根据以下视频信息，输出3-5个主题标签，只输出JSON数组，不加任何其他文字。
例如：["投资","指数基金","长期持有"]

{context}"""

    if not DEEPSEEK_API_KEY:
        raise HTTPException(501, "未配置 DEEPSEEK_API_KEY")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                json={"model": "deepseek-chat", "messages": [{"role": "user", "content": prompt}],
                      "max_tokens": 100, "temperature": 0.3}
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            tags = _json.loads(content)
            if isinstance(tags, list):
                update_ai_tags(bv_id, tags)
                return {"tags": tags, "source": "generated"}
    except Exception as e:
        raise HTTPException(500, f"标签生成失败: {e}")

    raise HTTPException(500, "标签生成失败")


class ExtractSubtitleRequest(BaseModel):
    bv_id: str
    whisper_model: str = "large-v3-turbo"
    keep_audio: bool = False


@app.post("/api/extract_subtitle")
async def extract_subtitle(req: ExtractSubtitleRequest):
    """单独提取字幕（ASR），流式进度反馈"""
    import json as _json
    from fastapi.responses import StreamingResponse
    from config import STORAGE_DIR

    def _prog(msg: str):
        return f"data: {_json.dumps({'progress': msg}, ensure_ascii=False)}\n\n"

    def _err(msg: str):
        return f"data: {_json.dumps({'error': msg}, ensure_ascii=False)}\n\n"

    async def stream_extract():
        # 已有字幕且非强制重写则直接返回
        try:
            subtitle_text = get_subtitle_text(req.bv_id)
        except Exception as e:
            yield _err(f"数据库查询失败: {e}"); return
        if subtitle_text:
            yield _prog(f"字幕已存在（{len(subtitle_text)} 字）")
            yield f"data: {_json.dumps({'done': True, 'char_count': len(subtitle_text)}, ensure_ascii=False)}\n\n"
            return

        loop = asyncio.get_event_loop()
        audio_dir = os.path.join(STORAGE_DIR, "audio")
        os.makedirs(audio_dir, exist_ok=True)

        # 1. 下载音频
        yield _prog("正在下载音频（可能需要 1-3 分钟）...")
        try:
            from asr import download_audio
            audio_path = await loop.run_in_executor(None, download_audio, req.bv_id, audio_dir)
        except RuntimeError as e:
            yield _err(str(e)); return
        except Exception as e:
            yield _err(f"下载失败: {e}"); return

        # 2. 加载模型
        yield _prog(f"正在加载 Whisper 模型 [{req.whisper_model}]...")
        try:
            from asr import _get_whisper_model
            model = await loop.run_in_executor(None, _get_whisper_model, req.whisper_model)
        except Exception as e:
            yield _err(f"模型加载失败: {e}"); return

        # 3. 转写
        yield _prog("正在转写音频...")
        try:
            from asr import transcribe_with_model
            result = await loop.run_in_executor(None, transcribe_with_model, model, audio_path)
        except Exception as e:
            yield _err(f"转写失败: {e}"); return

        if not result or not result.get("full_text"):
            yield _err("转写完成但未获取到文字内容"); return

        if not req.keep_audio and os.path.exists(audio_path):
            os.remove(audio_path)

        char_count = len(result["full_text"])
        # 确保视频记录存在（满足外键约束），再存字幕
        if not get_video(req.bv_id):
            upsert_video({"bv_id": req.bv_id, "title": req.bv_id, "has_subtitle": 1, "subtitle_source": "whisper"})
        upsert_subtitle(req.bv_id, {
            "full_text": result["full_text"],
            "timeline_json": result.get("timeline_json", []),
        })

        yield _prog(f"转写完成，共 {char_count} 字")
        yield f"data: {_json.dumps({'done': True, 'char_count': char_count}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream_extract(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/video/{bv_id}")
async def get_video_info(bv_id: str):
    """查询单个视频信息，附带字幕状态"""
    video = get_video(bv_id)
    if not video:
        raise HTTPException(404, "视频不存在")
    result = dict(video)
    subtitle_text = get_subtitle_text(bv_id)
    result["subtitle_in_db"] = bool(subtitle_text)
    result["subtitle_char_count"] = len(subtitle_text) if subtitle_text else 0
    result["has_summary"] = bool(result.get("summary"))
    result.pop("summary", None)  # 不传完整总结文本，节省流量
    return result


@app.get("/api/stats")
async def stats(period: str = "all"):
    """获取观看统计"""
    return get_stats(period)


@app.get("/api/balance")
async def balance():
    """查询当前 provider 的 API 余额（目前仅 DeepSeek 支持）"""
    import json as _j
    p = os.path.join(STORAGE_DIR, "settings.json")
    provider = 'deepseek'
    if os.path.exists(p):
        try:
            with open(p, 'r', encoding='utf-8') as f:
                provider = _j.load(f).get('default_provider', 'deepseek')
        except Exception:
            pass
    if provider != 'deepseek':
        return {"total_balance": None, "error": f"{provider} 暂不支持余额查询"}
    api_key, _ = _get_api_cfg(provider)
    if not api_key:
        return {"total_balance": None, "granted": None, "topped_up": None, "error": "未配置API Key"}
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                "https://api.deepseek.com/user/balance",
                headers={"Authorization": f"Bearer {api_key}"}
            )
            resp.raise_for_status()
            data = resp.json()
            infos = data.get("balance_infos", [])
            info = next((i for i in infos if float(i.get("total_balance", 0)) > 0), None)
            if info is None:
                info = next((i for i in infos if i.get("currency") == "CNY"), infos[0] if infos else {})
            return {
                "total_balance": info.get("total_balance", "0"),
                "granted": info.get("granted_balance", "0"),
                "topped_up": info.get("topped_up_balance", "0"),
                "currency": info.get("currency", "CNY"),
                "is_available": data.get("is_available", False),
                "all_balances": [{"currency": i.get("currency"), "total": i.get("total_balance")} for i in infos],
            }
    except Exception as e:
        return {"total_balance": None, "granted": None, "topped_up": None, "error": str(e)}


@app.get("/api/provider_models")
async def provider_models():
    """从 OpenRouter 公开 API 一次性获取所有厂商模型列表，无需 API Key"""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers={"HTTP-Referer": "http://localhost:9876", "X-Title": "BiliTracker"}
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        raise HTTPException(502, f"获取模型列表失败: {e}")

    # OpenRouter model ID 格式: "provider/model-name"
    # 对直连厂商去掉前缀（gpt-4o 而非 openai/gpt-4o）；openrouter 保留完整 ID
    _MAP = {'openai': 'openai', 'anthropic': 'anthropic',
            'google': 'google', 'deepseek': 'deepseek', 'mistralai': 'openrouter'}
    result = {k: [] for k in ('deepseek', 'openai', 'google', 'anthropic', 'openrouter')}

    for m in data.get('data', []):
        mid = m.get('id', '')
        name = m.get('name', mid)
        if '/' not in mid:
            continue
        prefix, model_id = mid.split('/', 1)
        prov_key = _MAP.get(prefix)

        # pricing.prompt / pricing.completion 是每 token 的 USD 价格，转为每百万 tokens
        pricing = m.get('pricing', {})
        try:
            p_in  = float(pricing.get('prompt', 0) or 0) * 1_000_000
            p_out = float(pricing.get('completion', 0) or 0) * 1_000_000
            # 价格为 0 视为未知（免费或未公开），返回 null
            input_price  = round(p_in,  4) if p_in  > 0 else None
            output_price = round(p_out, 4) if p_out > 0 else None
        except (TypeError, ValueError):
            input_price = output_price = None

        entry_direct = {'id': model_id, 'label': name, 'input': input_price, 'output': output_price, 'cur': '$'}
        entry_or     = {'id': mid,      'label': name, 'input': input_price, 'output': output_price, 'cur': '$'}

        if prov_key and prov_key != 'openrouter':
            result[prov_key].append(entry_direct)
        result['openrouter'].append(entry_or)  # OpenRouter 保留完整 ID

    return result


@app.get("/api/arena_elo")
async def arena_elo(refresh: bool = False):
    """返回 LM Arena ELO 分数。优先从本地数据库缓存读取；传 ?refresh=1 则重新从 HuggingFace 抓取并更新缓存。"""
    import httpx, json as _json
    from database import kv_get, kv_set

    if not refresh:
        # 从缓存读
        cached = kv_get("arena_elo")
        if cached:
            data = _json.loads(cached[0])
            data["cached_at"] = cached[1]
            return data
        # 缓存不存在时降级为实时抓取

    # 实时抓取 HuggingFace，失败则降级返回缓存
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            rows = []
            for offset in range(0, 300, 100):
                r = await client.get(
                    "https://datasets-server.huggingface.co/rows",
                    params={
                        "dataset": "lmarena-ai/leaderboard-dataset",
                        "config": "text",
                        "split": "latest",
                        "offset": offset,
                        "length": 100,
                    },
                    headers={"User-Agent": "BiliTracker/1.0"}
                )
                r.raise_for_status()
                rows.extend(r.json().get("rows", []))
    except Exception:
        # 网络失败时降级返回缓存（如果有）
        cached = kv_get("arena_elo")
        if cached:
            data = _json.loads(cached[0])
            data["cached_at"] = cached[1]
            return data
        raise HTTPException(502, "HuggingFace 访问失败且无本地缓存")

    scores = {}
    for item in rows:
        row = item.get("row", {})
        name   = row.get("model_name", "")
        rating = row.get("rating")
        if name and rating is not None:
            scores[name] = round(float(rating), 1)

    if not scores:
        raise HTTPException(502, "Arena ELO 数据为空")

    vals = list(scores.values())
    payload = {
        "scores": scores,
        "min": round(min(vals), 1),
        "max": round(max(vals), 1),
        "count": len(scores),
        "source": "lmarena-ai/leaderboard-dataset (text, latest)",
    }
    kv_set("arena_elo", _json.dumps(payload, ensure_ascii=False))
    return payload


@app.get("/api/exchange_rate")
async def exchange_rate():
    """获取当日 USD/CNY 汇率（来自公开接口，无需 API Key）"""
    import httpx
    async with httpx.AsyncClient(timeout=8) as client:
        r = await client.get(
            "https://api.exchangerate-api.com/v4/latest/USD",
            headers={"User-Agent": "BiliTracker/1.0"}
        )
        r.raise_for_status()
        data = r.json()
    rate = data.get("rates", {}).get("CNY")
    if not rate:
        raise HTTPException(502, "汇率接口未返回 CNY 数据")
    return {"USD_to_CNY": round(float(rate), 4), "source": "exchangerate-api.com", "date": data.get("date")}


@app.get("/api/videos")
async def list_videos(
    limit: int = 50, offset: int = 0,
    keyword: str = None,
    search_title: bool = True, search_up: bool = True, search_tags: bool = True,
    search_desc: bool = False, search_summary: bool = False, search_subtitle: bool = False,
):
    """查询视频列表。search_* 控制关键词匹配的字段范围"""
    from database import get_db
    conn = get_db()
    where_clauses = []
    params = []
    if keyword:
        kw = f"%{keyword}%"
        fields, kw_params = [], []
        if search_title:   fields.append("v.title LIKE ?");       kw_params.append(kw)
        if search_up:      fields.append("v.up_name LIKE ?");     kw_params.append(kw)
        if search_tags:    fields.append("v.tags LIKE ?");        kw_params.append(kw)
        if search_desc:    fields.append("v.description LIKE ?"); kw_params.append(kw)
        if search_summary: fields.append("v.summary LIKE ?");     kw_params.append(kw)
        if search_subtitle:fields.append("s.full_text LIKE ?");   kw_params.append(kw)
        if fields:
            where_clauses.append(f"({' OR '.join(fields)})")
            params.extend(kw_params)
    where = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    sub_join = "LEFT JOIN subtitles s ON v.bv_id = s.bv_id" if search_subtitle else ""
    rows = conn.execute(f"""
        SELECT v.*,
               MAX(w.is_autoplay) as has_autoplay,
               SUM(w.duration_sec) as total_duration,
               MAX(w.play_progress) as max_progress,
               (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.bv_id = v.bv_id) as chat_count,
               MAX(w.opened_at) as last_watched
        FROM videos v
        {sub_join}
        LEFT JOIN watch_records w ON v.bv_id = w.bv_id
        {where}
        GROUP BY v.bv_id
        ORDER BY last_watched DESC
        LIMIT ? OFFSET ?
    """, params + [limit, offset]).fetchall()
    if search_subtitle:
        total = conn.execute(f"SELECT COUNT(DISTINCT v.bv_id) as c FROM videos v {sub_join} {where}", params).fetchone()["c"]
    else:
        total = conn.execute(f"SELECT COUNT(*) as c FROM videos v {where}", params).fetchone()["c"]
    conn.close()
    return {"total": total, "videos": [dict(r) for r in rows]}


@app.get("/api/recommend_exclude")
async def recommend_exclude(
    max_sec: int = 60,
    autoplay: bool = True,
    no_activity: bool = True,
    max_progress: float = 0.1,
):
    """推荐可排除的视频（视频级，累计观看时长）"""
    from database import get_db
    conn = get_db()
    rows = conn.execute("""
        SELECT w.bv_id,
               v.title, v.up_name,
               SUM(w.duration_sec) as total_duration,
               MAX(w.play_progress) as max_progress,
               MAX(w.is_autoplay) as has_autoplay,
               MAX(w.opened_at) as last_watched,
               CASE WHEN v.summary IS NOT NULL THEN 1 ELSE 0 END as has_summary,
               (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.bv_id = v.bv_id) as chat_count
        FROM watch_records w
        JOIN videos v ON w.bv_id = v.bv_id
        WHERE (w.excluded = 0 OR w.excluded IS NULL) AND (v.excluded = 0 OR v.excluded IS NULL)
        GROUP BY w.bv_id
        ORDER BY last_watched DESC
        LIMIT 1000
    """).fetchall()
    conn.close()

    results = []
    for r in rows:
        reasons = []
        total_dur = r["total_duration"]
        prog = r["max_progress"]
        if max_sec > 0 and total_dur is not None and total_dur < max_sec:
            reasons.append(f"累计{total_dur}秒")
        if autoplay and r["has_autoplay"]:
            reasons.append("自动播放")
        if max_progress > 0 and prog is not None and prog < max_progress:
            reasons.append(f"最高进度{int(prog * 100)}%")
        if no_activity and not r["has_summary"] and r["chat_count"] == 0:
            reasons.append("无总结/对话")
        if reasons:
            results.append({
                "bv_id": r["bv_id"],
                "title": r["title"],
                "up_name": r["up_name"],
                "last_watched": r["last_watched"],
                "total_duration": total_dur,
                "reasons": reasons,
            })
    return {"records": results}


@app.post("/api/videos/bulk")
async def bulk_videos(req: dict):
    """批量操作视频：action = exclude | delete"""
    bv_ids = req.get("bv_ids", [])
    action = req.get("action", "exclude")
    if not bv_ids:
        return {"status": "ok", "count": 0}
    if action == "exclude":
        for bv_id in bv_ids:
            set_video_excluded(bv_id, True)
    elif action == "delete":
        for bv_id in bv_ids:
            delete_video_completely(bv_id)
    else:
        raise HTTPException(400, f"未知操作: {action}")
    return {"status": "ok", "count": len(bv_ids)}


@app.post("/api/watch_records/bulk")
async def bulk_watch_records(req: dict):
    """批量操作单条观看记录（明细视图用）：action = exclude | include | delete"""
    ids = req.get("ids", [])
    action = req.get("action", "exclude")
    if not ids:
        return {"status": "ok", "count": 0}
    if action == "exclude":
        for rid in ids:
            set_watch_record_excluded(rid, True)
    elif action == "include":
        for rid in ids:
            set_watch_record_excluded(rid, False)
    elif action == "delete":
        for rid in ids:
            delete_watch_record(rid)
    else:
        raise HTTPException(400, f"未知操作: {action}")
    return {"status": "ok", "count": len(ids)}


@app.get("/api/health")
async def health():
    """健康检查，含版本号供Extension比对"""
    from config import VERSION
    return {
        "status": "ok",
        "version": VERSION,
        "storage_dir": STORAGE_DIR,
        "db_path": DB_PATH,
        "db_exists": os.path.exists(DB_PATH)
    }


@app.post("/api/chat")
async def chat(req: dict):
    """对话：支持基于视频内容、数据分析、通用问答"""
    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL = _get_api_cfg()
    if not DEEPSEEK_API_KEY:
        raise HTTPException(501, "请在面板→设置中配置 API Key")

    model = req.get("model", "deepseek-chat")
    messages = req.get("messages", [])
    bv_id = req.get("bv_id")  # 可选：绑定视频上下文

    system_msg = "你是BiliTracker助手，帮助用户分析B站观看数据和视频内容。回答简洁直接。"

    # 如果绑定了视频，加入上下文
    if bv_id:
        video = get_video(bv_id)
        subtitle_text = get_subtitle_text(bv_id) or ""
        if video:
            ctx = f"\n当前视频：{video['title']}（UP主：{video['up_name']}，时长：{video['duration']}秒）"
            if subtitle_text:
                ctx += f"\n字幕全文（前8000字）：\n{subtitle_text[:8000]}"
            system_msg += ctx

    # 如果是数据分析请求，注入统计数据
    if req.get("include_stats"):
        from database import get_db
        conn = get_db()
        stats_data = get_stats("all")
        recent = conn.execute("""
            SELECT v.title, v.up_name, v.zone_primary, w.opened_at, w.duration_sec, w.max_speed
            FROM watch_records w JOIN videos v ON w.bv_id = v.bv_id
            ORDER BY w.opened_at DESC LIMIT 50
        """).fetchall()
        conn.close()
        stats_ctx = f"\n\n用户观看统计：共{stats_data['total_unique_videos']}个不同视频，{stats_data['total_watches']}次观看，总时长{stats_data['total_duration_hours']}小时。"
        stats_ctx += f"\n最常看的UP主：{', '.join((u['name'] or '未知') + '(' + str(u['count']) + '次)' for u in stats_data['top_ups'][:5])}"
        stats_ctx += f"\n最常看的分区：{', '.join((z['name'] or '未分类') + '(' + str(z['count']) + '次)' for z in stats_data['top_zones'][:5])}"
        stats_ctx += "\n最近50条观看记录：\n"
        for r in recent:
            stats_ctx += f"  {r['opened_at'][:16]} | {r['up_name']} | {r['title'][:30]} | {r['duration_sec']}s | {r['max_speed']}x\n"
        system_msg += stats_ctx

    full_messages = [{"role": "system", "content": system_msg}] + messages

    try:
        import httpx
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                json={"model": model, "messages": full_messages, "max_tokens": 4000, "temperature": 0.5}
            )
            resp.raise_for_status()
            data = resp.json()
            return {"reply": data["choices"][0]["message"]["content"], "model": model}
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"API错误: {e.response.text[:200]}")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/chat/session")
async def create_session(req: dict):
    """创建对话session并发送第一条消息"""
    import uuid
    sid = str(uuid.uuid4())[:8]
    bv_id = req.get("bv_id")
    model = req.get("model", "deepseek-chat")
    include_stats = req.get("include_stats", False)
    create_chat_session(sid, bv_id, model, include_stats)
    return {"session_id": sid}


@app.get("/api/chat/sessions")
async def list_sessions(limit: int = 50, bv_id: str = None):
    """获取对话session列表，可按视频过滤"""
    return {"sessions": get_chat_sessions(limit, bv_id=bv_id)}


@app.get("/api/chat/session/{session_id}")
async def get_session_messages(session_id: str):
    """获取某个session的所有消息"""
    return {"messages": get_chat_messages(session_id)}


@app.delete("/api/chat/session/{session_id}")
async def remove_session(session_id: str):
    """删除对话session"""
    delete_chat_session(session_id)
    return {"status": "ok"}


@app.post("/api/chat/send")
async def chat_send(req: dict):
    """在指定session中发送消息并获取回复（带持久化）"""
    session_id = req.get("session_id")
    user_msg = req.get("message", "")
    if not session_id or not user_msg:
        raise HTTPException(400, "需要session_id和message")

    # 先保存用户消息（无论API是否可用）
    try:
        add_chat_message(session_id, "user", user_msg)
    except Exception as e:
        raise HTTPException(500, f"消息保存失败: {e}")

    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL = _get_api_cfg()
    if not DEEPSEEK_API_KEY:
        raise HTTPException(501, "请在面板→设置中配置 API Key")

    # 读取session配置
    from database import get_db
    conn = get_db()
    session = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
    if not session:
        conn.close()
        raise HTTPException(404, "Session不存在")

    model = session["model"]
    bv_id = session["bv_id"]
    include_stats = session["include_stats"]

    # 读取历史消息
    history = get_chat_messages(session_id)
    messages = [{"role": m["role"], "content": m["content"]} for m in history]

    web_search_enabled = req.get("web_search", False)

    # 构建system prompt
    system_msg = "你是BiliTracker助手，帮助用户分析B站观看数据和视频内容。回答简洁直接。禁止使用Markdown格式（不用**加粗**、不用#标题、不用```代码块）。分点用【1】【2】【3】，强调用「」。"
    if web_search_enabled:
        system_msg += '\n\n你已接入实时网络搜索工具web_search。只要用户问及任何最新资讯、当前事件、实时数据，必须先调用web_search搜索，再基于搜索结果回答。绝对不能回复说无法获取最新信息。'

    if bv_id:
        video = get_video(bv_id)
        subtitle_text = get_subtitle_text(bv_id) or ""
        if video:
            ctx = f"\n当前视频：{video['title']}（UP主：{video['up_name']}，时长：{video['duration']}秒）"
            if subtitle_text:
                max_sub = 100000
                truncated = len(subtitle_text) > max_sub
                ctx += f"\n字幕（共{len(subtitle_text)}字{'，已截取前'+str(max_sub)+'字' if truncated else ''}）：\n{subtitle_text[:max_sub]}"
            system_msg += ctx

    if include_stats:
        stats_data = get_stats("all")
        recent = conn.execute("""
            SELECT v.title, v.up_name, v.zone_primary, w.opened_at, w.duration_sec, w.max_speed
            FROM watch_records w JOIN videos v ON w.bv_id = v.bv_id
            ORDER BY w.opened_at DESC LIMIT 50
        """).fetchall()
        stats_ctx = f"\n\n观看统计：{stats_data['total_unique_videos']}个视频，{stats_data['total_watches']}次观看，{stats_data['total_duration_hours']}小时。"
        stats_ctx += f"\nTOP UP主：{', '.join((u['name'] or '未知')+'('+str(u['count'])+')' for u in stats_data['top_ups'][:5])}"
        stats_ctx += f"\nTOP分区：{', '.join((z['name'] or '未分类')+'('+str(z['count'])+')' for z in stats_data['top_zones'][:5])}"
        stats_ctx += "\n近50条记录：\n"
        for r in recent:
            stats_ctx += f"  {r['opened_at'][:16]}|{r['up_name']}|{r['title'][:25]}|{r['duration_sec']}s|{r['max_speed']}x\n"
        system_msg += stats_ctx

    conn.close()

    full_messages = [{"role": "system", "content": system_msg}] + messages

    import httpx, json as _json
    from fastapi.responses import StreamingResponse

    def _sync_web_search(query: str) -> str:
        try:
            from ddgs import DDGS
        except ImportError:
            return "联网搜索功能需要安装 ddgs：pip install ddgs"
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=5):
                results.append(f"标题：{r['title']}\n链接：{r['href']}\n摘要：{r['body']}")
        return "\n\n".join(results) if results else "未找到相关结果"

    async def do_web_search(query: str) -> str:
        try:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, _sync_web_search, query)
        except Exception as e:
            return f"搜索失败: {e}"

    async def stream_reply():
        full_reply = []
        current_messages = list(full_messages)
        tools = [{
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "搜索互联网获取最新信息",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "搜索关键词"}
                    },
                    "required": ["query"]
                }
            }
        }] if web_search_enabled else []

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                while True:
                    payload = {
                        "model": model, "messages": current_messages,
                        "max_tokens": 4000, "temperature": 0.5, "stream": True
                    }
                    if tools:
                        payload["tools"] = tools
                        payload["tool_choice"] = "auto"

                    tool_calls_acc = {}
                    finish_reason = None
                    content_parts = []

                    async with client.stream(
                        "POST",
                        f"{DEEPSEEK_BASE_URL}/chat/completions",
                        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                        json=payload,
                    ) as resp:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            chunk = line[6:]
                            if chunk == "[DONE]":
                                break
                            try:
                                data = _json.loads(chunk)
                                choice = data["choices"][0]
                                if choice.get("finish_reason"):
                                    finish_reason = choice["finish_reason"]
                                delta = choice.get("delta", {})
                                # 推理过程（R1模型）
                                reasoning = delta.get("reasoning_content") or ""
                                if reasoning:
                                    yield f"data: {_json.dumps({'reasoning': reasoning}, ensure_ascii=False)}\n\n"
                                # 普通文本
                                text = delta.get("content") or ""
                                if text:
                                    content_parts.append(text)
                                    full_reply.append(text)
                                    yield f"data: {_json.dumps({'delta': text}, ensure_ascii=False)}\n\n"
                                # tool_calls 分片累积
                                for tc in delta.get("tool_calls") or []:
                                    idx = tc.get("index", 0)
                                    if idx not in tool_calls_acc:
                                        tool_calls_acc[idx] = {
                                            "id": tc.get("id", ""),
                                            "type": "function",
                                            "function": {"name": tc.get("function", {}).get("name", ""), "arguments": ""}
                                        }
                                    fn = tc.get("function", {})
                                    if fn.get("name"):
                                        tool_calls_acc[idx]["function"]["name"] = fn["name"]
                                    tool_calls_acc[idx]["function"]["arguments"] += fn.get("arguments", "")
                                    if tc.get("id"):
                                        tool_calls_acc[idx]["id"] = tc["id"]
                            except Exception:
                                continue

                    if finish_reason == "tool_calls" and tool_calls_acc:
                        tc_list = [tool_calls_acc[i] for i in sorted(tool_calls_acc)]
                        current_messages.append({
                            "role": "assistant",
                            "content": "".join(content_parts) or None,
                            "tool_calls": tc_list
                        })
                        for tc in tc_list:
                            fn_name = tc["function"]["name"]
                            try:
                                args = _json.loads(tc["function"]["arguments"])
                            except Exception:
                                args = {}
                            if fn_name == "web_search":
                                query = args.get("query", "")
                                notice = f"\n[搜索: {query}]\n"
                                yield f"data: {_json.dumps({'delta': notice}, ensure_ascii=False)}\n\n"
                                search_result = await do_web_search(query)
                                current_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "content": search_result
                                })
                        # 继续下一轮
                        continue
                    else:
                        break

        except Exception as e:
            yield f"data: {_json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            return

        reply_text = "".join(full_reply)
        add_chat_message(session_id, "assistant", reply_text)
        yield f"data: {_json.dumps({'done': True, 'session_id': session_id}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream_reply(), media_type="text/event-stream")


@app.post("/api/video/{bv_id}/exclude")
async def api_exclude_video(bv_id: str):
    """排除视频（不进入任何统计和分析）"""
    set_video_excluded(bv_id, True)
    return {"status": "ok"}


@app.post("/api/video/{bv_id}/include")
async def api_include_video(bv_id: str):
    """恢复已排除的视频"""
    set_video_excluded(bv_id, False)
    return {"status": "ok"}


@app.delete("/api/video/{bv_id}")
async def api_delete_video(bv_id: str):
    """完整删除视频及所有相关数据（记录、字幕、对话、干货）"""
    delete_video_completely(bv_id)
    return {"status": "ok"}


@app.get("/api/watch_records/{bv_id}")
async def list_watch_records(bv_id: str):
    """获取某视频的全部观看记录"""
    return {"records": get_watch_records(bv_id)}


@app.post("/api/watch_record/{record_id}/exclude")
async def exclude_record(record_id: int):
    """将观看记录标记为排除分析"""
    set_watch_record_excluded(record_id, True)
    return {"status": "ok"}


@app.post("/api/watch_record/{record_id}/include")
async def include_record(record_id: int):
    """恢复观看记录（取消排除）"""
    set_watch_record_excluded(record_id, False)
    return {"status": "ok"}


@app.delete("/api/watch_record/{record_id}")
async def remove_watch_record(record_id: int):
    """删除单条观看记录"""
    delete_watch_record(record_id)
    return {"status": "ok"}


@app.post("/api/backfill_ganghuo")
async def api_backfill_ganghuo():
    """从已有结构化总结中补录干货到 video_ganghuo 表"""
    count = backfill_ganghuo()
    return {"status": "ok", "processed": count}


@app.get("/api/stats/extended")
async def extended_stats():
    """扩展统计指标"""
    return get_extended_stats()


@app.get("/api/db/{table}")
async def browse_db(table: str, limit: int = 200, offset: int = 0):
    """数据库表浏览"""
    allowed = {"videos", "watch_records", "subtitles", "chat_sessions", "chat_messages"}
    if table not in allowed:
        raise HTTPException(400, f"不支持的表: {table}")
    from database import get_db
    conn = get_db()
    total = conn.execute(f"SELECT COUNT(*) as c FROM [{table}]").fetchone()["c"]
    rows = conn.execute(f"SELECT * FROM [{table}] ORDER BY rowid DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    columns = [desc[0] for desc in conn.execute(f"SELECT * FROM [{table}] LIMIT 1").description] if rows else []
    conn.close()
    return {"table": table, "total": total, "columns": columns, "rows": [dict(r) for r in rows]}


@app.get("/api/settings")
async def get_settings():
    """获取全局设置，合并 config.py 默认值"""
    import json as _j
    from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL
    p = os.path.join(STORAGE_DIR, "settings.json")
    saved = {}
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8') as f:
            saved = _j.load(f)
    # 迁移旧扁平格式到 providers 结构
    if ('api_key' in saved or 'api_base_url' in saved or 'default_model' in saved) \
            and 'providers' not in saved:
        prov = saved.get('default_provider', 'deepseek')
        saved.setdefault('providers', {}).setdefault(prov, {})
        if saved.get('api_key'):
            saved['providers'][prov]['api_key'] = saved.pop('api_key')
        if saved.get('api_base_url'):
            saved['providers'][prov]['api_base_url'] = saved.pop('api_base_url')
        if saved.get('default_model'):
            saved['providers'][prov]['default_model'] = saved.pop('default_model')
        with open(p, 'w', encoding='utf-8') as f:
            _j.dump(saved, f, ensure_ascii=False, indent=2)
    # 补全 deepseek 默认值（config.py）
    ds = saved.setdefault('providers', {}).setdefault('deepseek', {})
    if not ds.get('api_key'):   ds['api_key']      = DEEPSEEK_API_KEY or ""
    if not ds.get('api_base_url'): ds['api_base_url'] = DEEPSEEK_BASE_URL or "https://api.deepseek.com/v1"
    if not ds.get('default_model'): ds['default_model'] = "deepseek-chat"
    result = {
        "auto_asr":        saved.get('auto_asr', True),
        "whisper_model":   saved.get('whisper_model', 'large-v3-turbo'),
        "default_provider": saved.get('default_provider', 'deepseek'),
        "providers":       saved.get('providers', {}),
        "updated_at":      saved.get('updated_at', ''),
    }
    return result


@app.post("/api/settings")
async def post_settings(req: dict):
    """保存全局设置；providers 字段做深度合并"""
    import json as _j
    p = os.path.join(STORAGE_DIR, "settings.json")
    existing = {}
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8') as f:
            existing = _j.load(f)
    # providers 深度合并
    if 'providers' in req:
        ep = existing.setdefault('providers', {})
        for pname, pcfg in req.pop('providers').items():
            ep.setdefault(pname, {}).update(pcfg)
    existing.update(req)
    os.makedirs(STORAGE_DIR, exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        _j.dump(existing, f, ensure_ascii=False, indent=2)
    return existing


@app.get("/")
async def dashboard():
    """本地数据查看界面"""
    from fastapi.responses import HTMLResponse
    html_path = os.path.join(os.getcwd(), "dashboard.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


# ──────────────────────────────────────
# 启动
# ──────────────────────────────────────

def main():
    # pythonw.exe 运行时 sys.stdout/stderr 为 None（无控制台），重定向到日志文件
    if sys.stdout is None:
        log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_file = open(os.path.join(log_dir, "server.log"), "a", encoding="utf-8")
        sys.stdout = sys.stderr = log_file

    print(f"""
╔══════════════════════════════════════════╗
║        BiliTracker Server v1.3.0        ║
╠══════════════════════════════════════════╣
║  存储目录: {STORAGE_DIR:<28s} ║
║  数据库:   bilitracker.db                ║
║  监听地址: http://{HOST}:{PORT:<19d} ║
╚══════════════════════════════════════════╝
    """)

    os.makedirs(STORAGE_DIR, exist_ok=True)
    init_db()
    print(f"[✓] 数据库初始化完成: {DB_PATH}")

    # 后台预热 Whisper 模型，服务启动后立即开始加载，不阻塞主线程
    def _prewarm_whisper():
        try:
            from config import WHISPER_MODEL
            from asr import _get_whisper_model
            print(f"[~] 预热 Whisper 模型: {WHISPER_MODEL} ...")
            _get_whisper_model(WHISPER_MODEL)
            print(f"[✓] Whisper 模型已就绪: {WHISPER_MODEL}")
        except Exception as e:
            print(f"[!] Whisper 预热失败（不影响服务）: {e}")

    import threading
    threading.Thread(target=_prewarm_whisper, daemon=True).start()

    print(f"[✓] Server已启动，等待Extension连接...\n")

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
