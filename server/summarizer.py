"""DeepSeek API 总结模块（V1.1）"""
import httpx
from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL


def _format_duration(seconds: int) -> str:
    h, m = divmod(seconds, 3600)
    m, s = divmod(m, 60)
    if h > 0:
        return f"{h}小时{m}分钟"
    return f"{m}分钟{s}秒"


async def generate_summary(
    title: str,
    up_name: str,
    duration: int,
    subtitle_text: str,
    model: str = "deepseek-chat"
) -> str:
    """调用DeepSeek API生成视频总结"""
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("未设置DEEPSEEK_API_KEY环境变量")

    # 截断超长字幕（DeepSeek V3.2 128K上下文，留足输出空间）
    max_chars = 50000
    if len(subtitle_text) > max_chars:
        subtitle_text = subtitle_text[:max_chars] + "\n\n[字幕内容过长，已截断]"

    prompt = f"""你是一个视频内容分析助手。请根据以下视频字幕内容，生成结构化总结。

要求：
1. 一句话概括视频核心主题
2. 3-5个关键要点
3. 如有具体数据、结论或可操作建议，单独列出
4. 用自然段落，不要用bullet point

视频标题：{title}
UP主：{up_name}
时长：{_format_duration(duration)}

字幕内容：
{subtitle_text}"""

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 2000,
                "temperature": 0.3
            }
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
