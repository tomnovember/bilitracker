"""
BiliTracker CLI - 命令行工具
用法:
  python cli.py stats              # 查看统计
  python cli.py videos             # 列出最近视频
  python cli.py search <关键词>     # 搜索视频
  python cli.py info <BV号>        # 查看视频详情
  python cli.py chat               # 通用对话（含数据分析）
  python cli.py chat <BV号>        # 基于某视频对话
  python cli.py history            # 查看对话历史
  python cli.py export             # 导出CSV
  python cli.py db                 # 打印数据库概况
"""
import sys
import os
import json
import uuid
import asyncio

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server"))

from config import STORAGE_DIR, DB_PATH, DEEPSEEK_API_KEY
from database import (init_db, get_db, get_stats, get_extended_stats, get_video,
                       get_subtitle_text, get_chat_sessions, get_chat_messages,
                       create_chat_session, add_chat_message)


def cmd_stats():
    """统计概览"""
    d = get_extended_stats()
    print(f"""
╔══════════════════════════════════════════════╗
║            BiliTracker 统计概览              ║
╠══════════════════════════════════════════════╣
║  跟踪天数:     {d['tracking_days']:<28d}  ║
║  不同视频:     {d['total_unique_videos']:<28d}  ║
║  总观看次数:   {d['total_watches']:<28d}  ║
║  总时长:       {str(d['total_duration_hours'])+'h':<28s}  ║
║  日均观看:     {str(d['daily_avg_videos'])+'次':<28s}  ║
║  日均时长:     {str(d['daily_avg_hours'])+'h':<28s}  ║
║  平均最高倍速: {str(d['avg_max_speed'])+'x':<28s}  ║
║  播放完成率:   {str(d['completion_rate'])+'%':<28s}  ║
║  已总结视频:   {d['summarized_count']:<28d}  ║
╚══════════════════════════════════════════════╝""")

    if d['top_ups']:
        print("\n  最常看的UP主:")
        for i, u in enumerate(d['top_ups'][:10], 1):
            bar = "█" * min(30, int(u['count'] / d['top_ups'][0]['count'] * 30))
            print(f"    {i:2d}. {u['name']:<16s} {bar} {u['count']}")

    if d['top_zones']:
        print("\n  最常看的分区:")
        for i, z in enumerate(d['top_zones'][:10], 1):
            name = z['name'] or '未知'
            bar = "█" * min(30, int(z['count'] / d['top_zones'][0]['count'] * 30))
            print(f"    {i:2d}. {name:<12s} {bar} {z['count']}")

    if d['hourly']:
        print("\n  观看时段分布:")
        max_h = max(h['count'] for h in d['hourly']) if d['hourly'] else 1
        for h in d['hourly']:
            bar = "▓" * int(h['count'] / max_h * 40)
            print(f"    {h['hour']:02d}:00  {bar} {h['count']}")

    if d['referrer_types']:
        print("\n  来源分布:")
        for r in d['referrer_types']:
            print(f"    {r['type']:<14s} {r['count']}")

    print()


def cmd_videos(limit=20):
    """列出最近视频"""
    conn = get_db()
    rows = conn.execute("""
        SELECT v.bv_id, v.title, v.up_name, v.duration, v.zone_primary,
               COUNT(w.id) as wc, MAX(w.opened_at) as last,
               CASE WHEN v.summary IS NOT NULL THEN '✓' ELSE '' END as summ
        FROM videos v LEFT JOIN watch_records w ON v.bv_id = w.bv_id
        GROUP BY v.bv_id ORDER BY last DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()

    if not rows:
        print("  还没有记录。")
        return

    print(f"\n  {'BV号':<14s} {'标题':<30s} {'UP主':<12s} {'时长':>5s} {'观看':>4s} {'总结':>4s} {'最后观看'}")
    print("  " + "─" * 95)
    for r in rows:
        dur = f"{r['duration']//60}m" if r['duration'] else ""
        title = r['title'][:28] + ".." if len(r['title'] or '') > 28 else (r['title'] or '')
        up = (r['up_name'] or '')[:10]
        last = (r['last'] or '')[:10]
        print(f"  {r['bv_id']:<14s} {title:<30s} {up:<12s} {dur:>5s} {r['wc']:>4d} {r['summ']:>4s} {last}")
    print()


def cmd_search(keyword):
    """搜索视频"""
    conn = get_db()
    rows = conn.execute("""
        SELECT v.bv_id, v.title, v.up_name, v.duration,
               COUNT(w.id) as wc, MAX(w.opened_at) as last
        FROM videos v LEFT JOIN watch_records w ON v.bv_id = w.bv_id
        WHERE v.title LIKE ? OR v.up_name LIKE ? OR v.tags LIKE ?
        GROUP BY v.bv_id ORDER BY last DESC LIMIT 30
    """, (f"%{keyword}%", f"%{keyword}%", f"%{keyword}%")).fetchall()
    conn.close()

    if not rows:
        print(f"  未找到匹配 '{keyword}' 的视频。")
        return

    print(f"\n  搜索 '{keyword}' 找到 {len(rows)} 条:")
    print(f"  {'BV号':<14s} {'标题':<35s} {'UP主':<12s} {'观看':>4s}")
    print("  " + "─" * 70)
    for r in rows:
        title = r['title'][:33] + ".." if len(r['title'] or '') > 33 else (r['title'] or '')
        print(f"  {r['bv_id']:<14s} {title:<35s} {(r['up_name'] or ''):<12s} {r['wc']:>4d}")
    print()


def cmd_info(bv_id):
    """视频详情"""
    v = get_video(bv_id)
    if not v:
        print(f"  未找到视频 {bv_id}")
        return

    sub = get_subtitle_text(bv_id)
    conn = get_db()
    watches = conn.execute("SELECT * FROM watch_records WHERE bv_id=? ORDER BY opened_at DESC", (bv_id,)).fetchall()
    conn.close()

    tags = json.loads(v['tags'] or '[]')
    dur = f"{v['duration']//60}分{v['duration']%60}秒" if v['duration'] else "未知"

    print(f"""
  标题:   {v['title']}
  BV号:   {v['bv_id']}
  UP主:   {v['up_name']} (UID: {v['up_id']})
  时长:   {dur}
  分区:   {v['zone_primary'] or ''} / {v['zone_secondary'] or ''}
  标签:   {', '.join(tags[:8])}
  发布:   {(v['pub_date'] or '')[:10]}
  播放:   {v['view_count'] or 0:,}  点赞: {v['like_count'] or 0:,}  收藏: {v['favorite_count'] or 0:,}
  字幕:   {'有 (' + str(len(sub)) + '字)' if sub else '无'}
  总结:   {'有 (' + v['summary_model'] + ')' if v['summary'] else '无'}
  观看:   {len(watches)} 次""")

    if watches:
        print("\n  观看记录:")
        for w in watches[:10]:
            print(f"    {w['opened_at'][:16]}  停留{w['duration_sec'] or 0}s  进度{int((w['play_progress'] or 0)*100)}%  最高{w['max_speed']}x  {'完整' if w['completed'] else '未完'}")

    if v['summary']:
        print(f"\n  AI总结:\n  {'─'*50}")
        for line in v['summary'].split('\n'):
            print(f"  {line}")

    print()


def cmd_chat(bv_id=None):
    """交互式对话"""
    if not DEEPSEEK_API_KEY:
        print("  请先设置环境变量 DEEPSEEK_API_KEY")
        return

    sid = str(uuid.uuid4())[:8]
    create_chat_session(sid, bv_id, "deepseek-v4-flash", include_stats=True)

    ctx = ""
    if bv_id:
        v = get_video(bv_id)
        if v:
            ctx = f"（绑定视频：{v['title']}）"
            print(f"  对话绑定视频: {v['title']}")
        else:
            print(f"  未找到 {bv_id}，仅使用观看数据对话")

    print(f"  对话已开始{ctx}，输入 exit 退出\n")

    async def run():
        import httpx
        from config import DEEPSEEK_BASE_URL
        from database import get_stats as gs

        messages = []
        system_msg = "你是BiliTracker助手，帮助用户分析B站观看数据和视频内容。回答简洁直接。"

        if bv_id:
            v = get_video(bv_id)
            sub = get_subtitle_text(bv_id) or ""
            if v:
                system_msg += f"\n当前视频：{v['title']}（UP主：{v['up_name']}，时长：{v['duration']}秒）"
                if sub:
                    system_msg += f"\n字幕前8000字：\n{sub[:8000]}"

        # 注入统计
        stats = gs("all")
        conn = get_db()
        recent = conn.execute("""
            SELECT v.title, v.up_name, v.zone_primary, w.opened_at, w.duration_sec, w.max_speed
            FROM watch_records w JOIN videos v ON w.bv_id = v.bv_id
            ORDER BY w.opened_at DESC LIMIT 50
        """).fetchall()
        conn.close()
        system_msg += f"\n\n观看统计：{stats['total_unique_videos']}视频，{stats['total_watches']}次，{stats['total_duration_hours']}h"
        system_msg += f"\nTOP UP主：{', '.join(u['name']+'('+str(u['count'])+')' for u in stats['top_ups'][:5])}"
        for r in recent[:20]:
            system_msg += f"\n  {r['opened_at'][:16]}|{r['up_name']}|{r['title'][:25]}|{r['max_speed']}x"

        while True:
            try:
                user_input = input("  你: ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not user_input or user_input.lower() in ('exit', 'quit', 'q'):
                break

            messages.append({"role": "user", "content": user_input})
            add_chat_message(sid, "user", user_input)

            full = [{"role": "system", "content": system_msg}] + messages

            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.post(
                        f"{DEEPSEEK_BASE_URL}/chat/completions",
                        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                        json={"model": "deepseek-v4-flash", "messages": full, "max_tokens": 4000}
                    )
                    resp.raise_for_status()
                    reply = resp.json()["choices"][0]["message"]["content"]
                    messages.append({"role": "assistant", "content": reply})
                    add_chat_message(sid, "assistant", reply)
                    print(f"\n  AI: {reply}\n")
            except Exception as e:
                print(f"  错误: {e}\n")

        print("  对话结束。")

    asyncio.run(run())


def cmd_history():
    """对话历史"""
    sessions = get_chat_sessions(30)
    if not sessions:
        print("  没有对话记录。")
        return

    print(f"\n  {'ID':<10s} {'标题':<22s} {'视频':<20s} {'消息':>4s} {'时间'}")
    print("  " + "─" * 75)
    for s in sessions:
        title = (s['title'] or '')[:20]
        video = (s['video_title'] or '通用对话')[:18]
        print(f"  {s['id']:<10s} {title:<22s} {video:<20s} {s['msg_count']:>4d} {s['updated_at'][:16]}")

    print("\n  查看某对话详情: python cli.py history <session_id>")
    print()


def cmd_history_detail(session_id):
    """某对话的详细内容"""
    msgs = get_chat_messages(session_id)
    if not msgs:
        print(f"  对话 {session_id} 不存在或无消息。")
        return

    print(f"\n  对话 {session_id} ({len(msgs)} 条消息):\n")
    for m in msgs:
        role = "你" if m['role'] == 'user' else "AI"
        content = m['content'][:200] + "..." if len(m['content']) > 200 else m['content']
        print(f"  [{role}] {content}\n")


def cmd_export():
    """导出CSV"""
    import csv
    conn = get_db()

    # 导出视频
    videos_path = os.path.join(STORAGE_DIR, "export_videos.csv")
    rows = conn.execute("SELECT * FROM videos ORDER BY last_updated_at DESC").fetchall()
    if rows:
        with open(videos_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(rows[0].keys())
            for r in rows:
                writer.writerow(tuple(r))
        print(f"  视频导出: {videos_path} ({len(rows)} 条)")

    # 导出观看记录
    watches_path = os.path.join(STORAGE_DIR, "export_watches.csv")
    rows = conn.execute("SELECT * FROM watch_records ORDER BY opened_at DESC").fetchall()
    if rows:
        with open(watches_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(rows[0].keys())
            for r in rows:
                writer.writerow(tuple(r))
        print(f"  观看记录导出: {watches_path} ({len(rows)} 条)")

    conn.close()
    print()


def cmd_db():
    """数据库概况"""
    conn = get_db()
    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    print(f"\n  数据库: {DB_PATH}")
    print(f"  大小: {os.path.getsize(DB_PATH) / 1024:.1f} KB\n")
    for t in tables:
        name = t['name']
        count = conn.execute(f"SELECT COUNT(*) as c FROM [{name}]").fetchone()['c']
        print(f"    {name:<20s} {count:>6d} 条")
    conn.close()
    print()


# ── 入口 ──

def main():
    os.makedirs(STORAGE_DIR, exist_ok=True)
    init_db()

    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return

    cmd = args[0].lower()

    if cmd == "stats":
        cmd_stats()
    elif cmd == "videos":
        cmd_videos(int(args[1]) if len(args) > 1 else 20)
    elif cmd == "search" and len(args) > 1:
        cmd_search(" ".join(args[1:]))
    elif cmd == "info" and len(args) > 1:
        cmd_info(args[1])
    elif cmd == "chat":
        cmd_chat(args[1] if len(args) > 1 else None)
    elif cmd == "history":
        if len(args) > 1:
            cmd_history_detail(args[1])
        else:
            cmd_history()
    elif cmd == "export":
        cmd_export()
    elif cmd == "db":
        cmd_db()
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
