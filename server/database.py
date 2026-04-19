"""SQLite 数据库初始化与读写"""
import sqlite3
import os
import json
from datetime import datetime
from config import DB_PATH, STORAGE_DIR


def get_db() -> sqlite3.Connection:
    """获取数据库连接"""
    os.makedirs(STORAGE_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _migrate(conn):
    """运行时迁移：给已有表加新列"""
    migrations = [
        "ALTER TABLE videos ADD COLUMN ai_tags TEXT",
        "ALTER TABLE watch_records ADD COLUMN excluded INTEGER DEFAULT 0",
        "ALTER TABLE videos ADD COLUMN excluded INTEGER DEFAULT 0",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except Exception:
            pass  # 列已存在
    conn.commit()


def init_db():
    """初始化数据库表结构"""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS videos (
            bv_id           TEXT PRIMARY KEY,
            av_id           TEXT,
            title           TEXT NOT NULL,
            description     TEXT,
            cover_url       TEXT,
            duration        INTEGER,
            pub_date        TEXT,
            up_id           TEXT,
            up_name         TEXT,
            up_fans_count   INTEGER,
            zone_primary    TEXT,
            zone_secondary  TEXT,
            tags            TEXT,
            total_parts     INTEGER DEFAULT 1,
            view_count      INTEGER,
            danmaku_count   INTEGER,
            like_count      INTEGER,
            coin_count      INTEGER,
            favorite_count  INTEGER,
            share_count     INTEGER,
            reply_count     INTEGER,
            has_subtitle    INTEGER DEFAULT 0,
            subtitle_source TEXT,
            subtitle_lang   TEXT,
            first_seen_at   TEXT NOT NULL,
            last_updated_at TEXT NOT NULL,
            user_tags       TEXT,
            user_notes      TEXT,
            user_rating     INTEGER,
            summary         TEXT,
            summary_model   TEXT,
            summary_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS watch_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            bv_id           TEXT NOT NULL,
            opened_at       TEXT NOT NULL,
            closed_at       TEXT,
            duration_sec    INTEGER,
            part_number     INTEGER DEFAULT 1,
            part_title      TEXT,
            play_progress   REAL,
            play_seconds    INTEGER,
            completed       INTEGER DEFAULT 0,
            max_speed       REAL DEFAULT 1.0,
            speed_changes   TEXT,
            is_fullscreen   INTEGER DEFAULT 0,
            is_autoplay     INTEGER DEFAULT 0,
            autoplay_session TEXT,
            autoplay_index  INTEGER,
            referrer_url    TEXT,
            referrer_type   TEXT,
            search_keyword  TEXT,
            tab_visible_sec INTEGER,
            snapshot_views  INTEGER,
            snapshot_likes  INTEGER,
            screen_width    INTEGER,
            screen_height   INTEGER,
            FOREIGN KEY (bv_id) REFERENCES videos(bv_id)
        );

        CREATE INDEX IF NOT EXISTS idx_watch_bv ON watch_records(bv_id);
        CREATE INDEX IF NOT EXISTS idx_watch_time ON watch_records(opened_at);
        CREATE INDEX IF NOT EXISTS idx_watch_autoplay ON watch_records(autoplay_session);

        CREATE TABLE IF NOT EXISTS subtitles (
            bv_id           TEXT PRIMARY KEY,
            full_text       TEXT,
            timeline_json   TEXT,
            char_count      INTEGER,
            word_count      INTEGER,
            fetched_at      TEXT NOT NULL,
            FOREIGN KEY (bv_id) REFERENCES videos(bv_id)
        );

        CREATE TABLE IF NOT EXISTS video_ganghuo (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            bv_id           TEXT NOT NULL,
            类型            TEXT,
            内容            TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            FOREIGN KEY (bv_id) REFERENCES videos(bv_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ganghuo_bv ON video_ganghuo(bv_id);
        CREATE INDEX IF NOT EXISTS idx_ganghuo_type ON video_ganghuo(类型);

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id              TEXT PRIMARY KEY,
            bv_id           TEXT,
            title           TEXT,
            model           TEXT,
            include_stats   INTEGER DEFAULT 0,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            FOREIGN KEY (bv_id) REFERENCES videos(bv_id)
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_messages(session_id);

        CREATE TABLE IF NOT EXISTS kv_cache (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
    """)
    conn.commit()
    _migrate(conn)
    conn.close()


def kv_get(key: str):
    """读取 kv_cache，返回 (value_str, updated_at) 或 None"""
    conn = get_db()
    row = conn.execute("SELECT value, updated_at FROM kv_cache WHERE key=?", (key,)).fetchone()
    conn.close()
    return (row["value"], row["updated_at"]) if row else None


def kv_set(key: str, value: str):
    """写入 kv_cache"""
    conn = get_db()
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT INTO kv_cache(key,value,updated_at) VALUES(?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, value, now)
    )
    conn.commit()
    conn.close()


def upsert_video(data: dict) -> str:
    """插入或更新视频信息，返回bv_id"""
    conn = get_db()
    now = datetime.now().isoformat()
    bv_id = data["bv_id"]

    existing = conn.execute("SELECT bv_id, first_seen_at FROM videos WHERE bv_id = ?", (bv_id,)).fetchone()

    if existing:
        conn.execute("""
            UPDATE videos SET
                title=?, description=?, cover_url=?, duration=?, pub_date=?,
                up_id=?, up_name=?, up_fans_count=?,
                zone_primary=?, zone_secondary=?, tags=?, total_parts=?,
                view_count=?, danmaku_count=?, like_count=?, coin_count=?,
                favorite_count=?, share_count=?, reply_count=?,
                has_subtitle=?, subtitle_source=?, subtitle_lang=?,
                last_updated_at=?
            WHERE bv_id=?
        """, (
            data.get("title", ""), data.get("description"), data.get("cover_url"),
            data.get("duration"), data.get("pub_date"),
            data.get("up_id"), data.get("up_name"), data.get("up_fans_count"),
            data.get("zone_primary"), data.get("zone_secondary"),
            json.dumps(data.get("tags", []), ensure_ascii=False),
            data.get("total_parts", 1),
            data.get("view_count"), data.get("danmaku_count"),
            data.get("like_count"), data.get("coin_count"),
            data.get("favorite_count"), data.get("share_count"), data.get("reply_count"),
            data.get("has_subtitle", 0), data.get("subtitle_source"), data.get("subtitle_lang"),
            now, bv_id
        ))
    else:
        conn.execute("""
            INSERT INTO videos (
                bv_id, av_id, title, description, cover_url, duration, pub_date,
                up_id, up_name, up_fans_count,
                zone_primary, zone_secondary, tags, total_parts,
                view_count, danmaku_count, like_count, coin_count,
                favorite_count, share_count, reply_count,
                has_subtitle, subtitle_source, subtitle_lang,
                first_seen_at, last_updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            bv_id, data.get("av_id"),
            data.get("title", ""), data.get("description"), data.get("cover_url"),
            data.get("duration"), data.get("pub_date"),
            data.get("up_id"), data.get("up_name"), data.get("up_fans_count"),
            data.get("zone_primary"), data.get("zone_secondary"),
            json.dumps(data.get("tags", []), ensure_ascii=False),
            data.get("total_parts", 1),
            data.get("view_count"), data.get("danmaku_count"),
            data.get("like_count"), data.get("coin_count"),
            data.get("favorite_count"), data.get("share_count"), data.get("reply_count"),
            data.get("has_subtitle", 0), data.get("subtitle_source"), data.get("subtitle_lang"),
            now, now
        ))

    conn.commit()
    conn.close()
    return bv_id


def insert_watch_record(data: dict) -> int:
    """插入观看记录，返回record id"""
    conn = get_db()
    cursor = conn.execute("""
        INSERT INTO watch_records (
            bv_id, opened_at, closed_at, duration_sec,
            part_number, part_title, play_progress, play_seconds, completed,
            max_speed, speed_changes, is_fullscreen,
            is_autoplay, autoplay_session, autoplay_index,
            referrer_url, referrer_type, search_keyword,
            tab_visible_sec, snapshot_views, snapshot_likes,
            screen_width, screen_height
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        data["bv_id"], data["opened_at"], data.get("closed_at"), data.get("duration_sec"),
        data.get("part_number", 1), data.get("part_title"),
        data.get("play_progress"), data.get("play_seconds"), data.get("completed", 0),
        data.get("max_speed", 1.0),
        json.dumps(data.get("speed_changes", []), ensure_ascii=False),
        data.get("is_fullscreen", 0),
        data.get("is_autoplay", 0), data.get("autoplay_session"), data.get("autoplay_index"),
        data.get("referrer_url"), data.get("referrer_type"), data.get("search_keyword"),
        data.get("tab_visible_sec"), data.get("snapshot_views"), data.get("snapshot_likes"),
        data.get("screen_width"), data.get("screen_height")
    ))
    record_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return record_id


def upsert_subtitle(bv_id: str, data: dict):
    """插入或更新字幕（同一bv_id保留最新数据）"""
    if not data.get("full_text"):
        return
    conn = get_db()
    full_text = data["full_text"]
    conn.execute("""
        INSERT INTO subtitles (bv_id, full_text, timeline_json, char_count, word_count, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(bv_id) DO UPDATE SET
            full_text   = excluded.full_text,
            timeline_json = excluded.timeline_json,
            char_count  = excluded.char_count,
            word_count  = excluded.word_count,
            fetched_at  = excluded.fetched_at
    """, (
        bv_id, full_text,
        json.dumps(data.get("timeline_json", []), ensure_ascii=False),
        len(full_text),
        len(full_text) // 2,
        datetime.now().isoformat()
    ))
    conn.commit()
    conn.close()


def get_video(bv_id: str) -> dict | None:
    """查询单个视频"""
    conn = get_db()
    row = conn.execute("SELECT * FROM videos WHERE bv_id = ?", (bv_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_subtitle_text(bv_id: str) -> str | None:
    """获取视频字幕全文"""
    conn = get_db()
    row = conn.execute("SELECT full_text FROM subtitles WHERE bv_id = ?", (bv_id,)).fetchone()
    conn.close()
    return row["full_text"] if row else None




def update_summary(bv_id: str, summary: str, model: str, ai_tags: list = None):
    """更新视频总结，可选同时保存 AI 标签"""
    conn = get_db()
    now = datetime.now().isoformat()
    if ai_tags is not None:
        conn.execute("""
            UPDATE videos SET summary=?, summary_model=?, summary_at=?, ai_tags=? WHERE bv_id=?
        """, (summary, model, now, json.dumps(ai_tags, ensure_ascii=False), bv_id))
    else:
        conn.execute("""
            UPDATE videos SET summary=?, summary_model=?, summary_at=? WHERE bv_id=?
        """, (summary, model, now, bv_id))
    conn.commit()
    conn.close()


def upsert_ganghuo(bv_id: str, ganghuo: list):
    """替换某视频的全部干货条目"""
    if not ganghuo:
        return
    conn = get_db()
    now = datetime.now().isoformat()
    conn.execute("DELETE FROM video_ganghuo WHERE bv_id = ?", (bv_id,))
    for item in ganghuo:
        if isinstance(item, dict):
            lx = item.get("类型", "")
            content = item.get("内容", "")
        else:
            lx, content = "", str(item)
        if content.strip():
            conn.execute(
                "INSERT INTO video_ganghuo (bv_id, 类型, 内容, created_at) VALUES (?,?,?,?)",
                (bv_id, lx, content, now)
            )
    conn.commit()
    conn.close()


def backfill_ganghuo() -> int:
    """从已有 summary JSON 中提取干货写入 video_ganghuo，返回处理视频数"""
    conn = get_db()
    rows = conn.execute(
        "SELECT bv_id, summary FROM videos WHERE summary IS NOT NULL AND summary != ''"
    ).fetchall()
    conn.close()
    count = 0
    for row in rows:
        try:
            data = json.loads(row["summary"])
            ganghuo = data.get("干货", [])
            if ganghuo:
                upsert_ganghuo(row["bv_id"], ganghuo)
                count += 1
        except Exception:
            pass
    return count


def update_ai_tags(bv_id: str, tags: list):
    """单独更新 AI 标签（用于轻量打标签）"""
    conn = get_db()
    conn.execute("UPDATE videos SET ai_tags=? WHERE bv_id=?",
                 (json.dumps(tags, ensure_ascii=False), bv_id))
    conn.commit()
    conn.close()


def set_video_excluded(bv_id: str, excluded: bool):
    """排除或恢复视频（视频级 flag，影响全部统计和分析）"""
    conn = get_db()
    conn.execute("UPDATE videos SET excluded = ? WHERE bv_id = ?",
                 (1 if excluded else 0, bv_id))
    conn.commit()
    conn.close()


def delete_video_completely(bv_id: str):
    """完整删除视频及所有相关数据（记录、字幕、对话、干货）"""
    conn = get_db()
    conn.execute("DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE bv_id = ?)", (bv_id,))
    conn.execute("DELETE FROM chat_sessions WHERE bv_id = ?", (bv_id,))
    conn.execute("DELETE FROM video_ganghuo WHERE bv_id = ?", (bv_id,))
    conn.execute("DELETE FROM subtitles WHERE bv_id = ?", (bv_id,))
    conn.execute("DELETE FROM watch_records WHERE bv_id = ?", (bv_id,))
    conn.execute("DELETE FROM videos WHERE bv_id = ?", (bv_id,))
    conn.commit()
    conn.close()


def get_watch_records(bv_id: str) -> list:
    """获取某视频的全部观看记录"""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM watch_records WHERE bv_id = ? ORDER BY opened_at DESC",
        (bv_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_watch_record_excluded(record_id: int, excluded: bool):
    """标记/取消标记观看记录为排除分析"""
    conn = get_db()
    conn.execute("UPDATE watch_records SET excluded = ? WHERE id = ?",
                 (1 if excluded else 0, record_id))
    conn.commit()
    conn.close()


def delete_watch_record(record_id: int):
    """删除单条观看记录"""
    conn = get_db()
    conn.execute("DELETE FROM watch_records WHERE id = ?", (record_id,))
    conn.commit()
    conn.close()


def get_stats(period: str = "all") -> dict:
    """获取观看统计（排除 excluded 记录和视频）"""
    conn = get_db()

    # 同时过滤 watch_records.excluded 和 videos.excluded
    excl = ("(w.excluded = 0 OR w.excluded IS NULL) "
            "AND w.bv_id NOT IN (SELECT bv_id FROM videos WHERE excluded = 1)")
    if period == "week":
        where = f"WHERE {excl} AND w.opened_at >= datetime('now', 'localtime', '-7 days')"
    elif period == "month":
        where = f"WHERE {excl} AND w.opened_at >= datetime('now', 'localtime', '-30 days')"
    elif period == "year":
        where = f"WHERE {excl} AND w.opened_at >= datetime('now', 'localtime', '-365 days')"
    else:
        where = f"WHERE {excl}"

    total_videos = conn.execute(f"SELECT COUNT(DISTINCT bv_id) as c FROM watch_records w {where}").fetchone()["c"]
    total_watches = conn.execute(f"SELECT COUNT(*) as c FROM watch_records w {where}").fetchone()["c"]
    total_duration = conn.execute(f"SELECT COALESCE(SUM(duration_sec), 0) as s FROM watch_records w {where}").fetchone()["s"]

    top_ups = conn.execute(f"""
        SELECT v.up_name, COUNT(*) as cnt
        FROM watch_records w JOIN videos v ON w.bv_id = v.bv_id
        {where}
        GROUP BY v.up_name ORDER BY cnt DESC LIMIT 10
    """).fetchall()

    top_zones = conn.execute(f"""
        SELECT v.zone_primary, COUNT(*) as cnt
        FROM watch_records w JOIN videos v ON w.bv_id = v.bv_id
        {where}
        GROUP BY v.zone_primary ORDER BY cnt DESC LIMIT 10
    """).fetchall()

    conn.close()
    return {
        "total_unique_videos": total_videos,
        "total_watches": total_watches,
        "total_duration_sec": total_duration,
        "total_duration_hours": round(total_duration / 3600, 1),
        "top_ups": [{"name": r["up_name"], "count": r["cnt"]} for r in top_ups],
        "top_zones": [{"name": r["zone_primary"], "count": r["cnt"]} for r in top_zones],
    }


def get_extended_stats() -> dict:
    """扩展统计指标"""
    conn = get_db()
    base = get_stats("all")

    _excl = ("(excluded = 0 OR excluded IS NULL) "
             "AND bv_id NOT IN (SELECT bv_id FROM videos WHERE excluded = 1)")
    # 日均观看
    first = conn.execute(f"SELECT MIN(opened_at) as m FROM watch_records WHERE {_excl}").fetchone()["m"]
    if first:
        from datetime import datetime as dt
        try:
            first_dt = dt.fromisoformat(first)
        except ValueError:
            # fallback: 只取日期部分
            first_dt = dt.strptime(first[:10], "%Y-%m-%d")
        days = max(1, (dt.now() - first_dt.replace(tzinfo=None)).days + 1)
        base["daily_avg_videos"] = round(base["total_watches"] / days, 1)
        base["daily_avg_hours"] = round(base["total_duration_hours"] / days, 2)
        base["tracking_days"] = days
    else:
        base["daily_avg_videos"] = 0
        base["daily_avg_hours"] = 0
        base["tracking_days"] = 0

    # 小时分布
    hourly = conn.execute(f"""
        SELECT CAST(strftime('%H', opened_at) AS INTEGER) as hour, COUNT(*) as cnt
        FROM watch_records WHERE {_excl}
        GROUP BY hour ORDER BY hour
    """).fetchall()
    base["hourly"] = [{"hour": r["hour"], "count": r["cnt"]} for r in hourly]

    # 每日趋势（最近30天）
    daily = conn.execute(f"""
        SELECT date(opened_at) as day, COUNT(*) as cnt
        FROM watch_records
        WHERE {_excl} AND opened_at >= datetime('now', 'localtime', '-30 days')
        GROUP BY day ORDER BY day
    """).fetchall()
    base["daily_trend"] = [{"day": r["day"], "count": r["cnt"]} for r in daily]

    # 平均倍速
    avg_speed = conn.execute(f"SELECT AVG(max_speed) as a FROM watch_records WHERE {_excl}").fetchone()["a"]
    base["avg_max_speed"] = round(avg_speed or 1.0, 2)

    # 完成率
    total = conn.execute(f"SELECT COUNT(*) as c FROM watch_records WHERE {_excl}").fetchone()["c"]
    completed = conn.execute(f"SELECT COUNT(*) as c FROM watch_records WHERE completed=1 AND {_excl}").fetchone()["c"]
    base["completion_rate"] = round(completed / max(total, 1) * 100, 1)

    # 有总结的视频数（排除已排除视频）
    summarized = conn.execute("SELECT COUNT(*) as c FROM videos WHERE summary IS NOT NULL AND (excluded = 0 OR excluded IS NULL)").fetchone()["c"]
    base["summarized_count"] = summarized

    # 来源分布
    sources = conn.execute(f"""
        SELECT referrer_type, COUNT(*) as cnt FROM watch_records
        WHERE referrer_type IS NOT NULL AND {_excl}
        GROUP BY referrer_type ORDER BY cnt DESC
    """).fetchall()
    base["referrer_types"] = [{"type": r["referrer_type"], "count": r["cnt"]} for r in sources]

    # 标签统计（从 videos.tags JSON 数组展开）
    try:
        top_tags = conn.execute("""
            SELECT value as tag, COUNT(*) as cnt
            FROM videos, json_each(videos.tags)
            WHERE (excluded = 0 OR excluded IS NULL)
              AND tags IS NOT NULL AND tags != '[]' AND tags != 'null'
              AND value != ''
            GROUP BY value
            ORDER BY cnt DESC
            LIMIT 20
        """).fetchall()
        base["top_tags"] = [{"tag": r["tag"], "count": r["cnt"]} for r in top_tags]
    except Exception:
        base["top_tags"] = []

    conn.close()
    return base


# ── 对话记录 CRUD ──

def create_chat_session(session_id: str, bv_id: str = None, model: str = "deepseek-chat", include_stats: bool = False, title: str = None) -> str:
    conn = get_db()
    now = datetime.now().isoformat()
    conn.execute("""
        INSERT INTO chat_sessions (id, bv_id, title, model, include_stats, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (session_id, bv_id, title or "新对话", model, 1 if include_stats else 0, now, now))
    conn.commit()
    conn.close()
    return session_id


def add_chat_message(session_id: str, role: str, content: str):
    conn = get_db()
    now = datetime.now().isoformat()
    conn.execute("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                 (session_id, role, content, now))
    conn.execute("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", (now, session_id))
    # 自动更新标题（取用户第一条消息前20字）
    if role == "user":
        session = conn.execute("SELECT title FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
        if session and session["title"] == "新对话":
            conn.execute("UPDATE chat_sessions SET title = ? WHERE id = ?", (content[:20], session_id))
    conn.commit()
    conn.close()


def get_chat_sessions(limit: int = 50, bv_id: str = None) -> list:
    conn = get_db()
    if bv_id:
        rows = conn.execute("""
            SELECT s.*, v.title as video_title,
                   (SELECT COUNT(*) FROM chat_messages WHERE session_id = s.id) as msg_count
            FROM chat_sessions s
            LEFT JOIN videos v ON s.bv_id = v.bv_id
            WHERE s.bv_id = ?
            ORDER BY s.updated_at DESC LIMIT ?
        """, (bv_id, limit)).fetchall()
    else:
        rows = conn.execute("""
            SELECT s.*, v.title as video_title,
                   (SELECT COUNT(*) FROM chat_messages WHERE session_id = s.id) as msg_count
            FROM chat_sessions s
            LEFT JOIN videos v ON s.bv_id = v.bv_id
            ORDER BY s.updated_at DESC LIMIT ?
        """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_chat_messages(session_id: str) -> list:
    conn = get_db()
    rows = conn.execute("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at", (session_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_chat_session(session_id: str):
    conn = get_db()
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()
