/**
 * BiliTracker Content Script v1.2
 * 矩阵倍速按钮 + 状态灯 + 余额显示 + 总结按钮
 */

(function () {
  "use strict";

  if (window.__bilitracker_injected) return;
  window.__bilitracker_injected = true;

  const SERVER = "http://localhost:9876";
  const SPEEDS = [1, 2, 3, 5, 8, 16];

  const state = {
    bvId: null,
    openedAt: new Date().toISOString(),
    speedChanges: [],
    maxSpeed: 1.0,
    isFullscreen: false,
    playSeconds: 0,
    completed: false,
    tabVisibleStart: Date.now(),
    tabVisibleTotal: 0,
    tabVisible: !document.hidden,
    lastProgressUpdate: 0,
    autoplaySession: null,
    autoplayIndex: 0,
    isAutoplay: false,
    sent: false,
    hasSubtitle: false,
    subtitleExtracted: false,
    serverConnected: false,
    subtitleData: null,
    autoAsr: true,  // 从 server settings 读取
  };

  // ── 工具函数 ──
  function extractBvId() {
    const m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  }
  function getInitialState() {
    // 从page_bridge.js写入的DOM元素读取数据
    if (window.__bt_cached_state) return window.__bt_cached_state;
    const bridge = document.getElementById("__bt_state_bridge");
    if (bridge && bridge.getAttribute("data-ready") === "1") {
      try {
        window.__bt_cached_state = JSON.parse(bridge.textContent);
        return window.__bt_cached_state;
      } catch { return null; }
    }
    return null;
  }
  function getReferrerType() {
    const r = document.referrer;
    if (!r) return "direct";
    if (r.includes("search")) return "search";
    if (r.includes("space.bilibili.com")) return "up_space";
    if (r.includes("toview") || r.includes("favlist")) return "favorite";
    if (r.includes("/video/")) return "related";
    if (r.includes("bilibili.com")) return "recommend";
    return "external";
  }
  function getSearchKeyword() {
    try {
      const p = new URLSearchParams(document.referrer.split("?")[1]);
      return p.get("keyword") || p.get("search_keyword") || null;
    } catch { return null; }
  }

  // ── Server检测 + 余额 ──
  async function checkServer() {
    try {
      const r = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(2000) });
      state.serverConnected = r.ok;
      if (r.ok) {
        const d = await r.json();
        // 版本比对
        if (d.version) {
          const extVer = chrome.runtime.getManifest().version;
          if (d.version !== extVer && !state._versionWarned) {
            state._versionWarned = true;
            showToast(`Extension(${extVer})与Server(${d.version})版本不一致，请到 chrome://extensions 点刷新`, "warn");
          }
        }
      }
    } catch { state.serverConnected = false; }
    if (state.serverConnected) {
      fetchBalance();
      // 读取 autoAsr 设置，控制悬浮窗字幕按钮显隐
      try {
        const sr = await fetch(`${SERVER}/api/settings`, { signal: AbortSignal.timeout(2000) });
        if (sr.ok) { const s = await sr.json(); state.autoAsr = s.auto_asr !== false; }
      } catch {}
    }
    updateStatusLights();
    return state.serverConnected;
  }

  function fetchBalance() {
    // 从background.js读缓存，所有上下文共享同一个值
    chrome.runtime.sendMessage({ type: "GET_BALANCE" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.cache) return;
      const d = resp.cache;
      const el = document.getElementById("bt-balance");
      if (!el || d.total_balance == null) return;
      const newVal = parseFloat(d.total_balance);
      el.textContent = `¥${d.total_balance}`;
      el.title = `充值: ¥${d.topped_up} | 赠送: ¥${d.granted}`;
      el.className = "bt-balance" + (newVal < 1 ? " bt-low" : "");
    });
  }

  // ── 视频元数据提取 ──
  function extractVideoData() {
    const ini = getInitialState();
    const vd = ini?.videoData || {};
    const up = ini?.upData || {};
    const stat = vd.stat || {};
    const tags = (ini?.tags || []).map(t => t.tag_name || t);
    const sl = (vd.subtitle || {}).list || [];
    const hasSub = sl.length > 0;
    let subSrc = "none", subLang = null;
    if (hasSub) {
      const first = sl[0];
      // ai_status=2 表示AI字幕已生成，lan以"ai-"开头也是AI字幕
      subSrc = (first.ai_status === 2 || (first.lan && first.lan.startsWith("ai-"))) ? "ai_generated" : "up_upload";
      subLang = first.lan || "zh-CN";
    }
    state.hasSubtitle = hasSub;
    updateStatusLights();
    return {
      bv_id: vd.bvid || extractBvId(),
      av_id: vd.aid ? `av${vd.aid}` : null,
      title: vd.title || document.title.replace(/_哔哩哔哩_bilibili/, "").trim(),
      description: vd.desc || null, cover_url: vd.pic || null,
      duration: vd.duration || null,
      pub_date: vd.pubdate ? new Date(vd.pubdate * 1000).toISOString() : null,
      up_id: up.mid ? String(up.mid) : null,
      up_name: up.name || document.querySelector(".up-name")?.textContent?.trim() || null,
      up_fans_count: up.fans || null,
      zone_primary: vd.tname || null, zone_secondary: null, tags,
      total_parts: (vd.pages || []).length || 1,
      view_count: stat.view, danmaku_count: stat.danmaku,
      like_count: stat.like, coin_count: stat.coin,
      favorite_count: stat.favorite, share_count: stat.share, reply_count: stat.reply,
      has_subtitle: hasSub ? 1 : 0, subtitle_source: subSrc, subtitle_lang: subLang,
    };
  }

  // ── 字幕提取 ──
  async function extractSubtitle() {
    const ini = getInitialState();
    const vd = ini?.videoData || {};
    const bvid = vd.bvid || extractBvId();
    const cid = vd.cid || (vd.pages && vd.pages[0]?.cid);
    if (!bvid || !cid) return null;

    // 方法1: __INITIAL_STATE__ 里如果有subtitle_url就直接用
    const slFromState = (vd.subtitle || {}).list || [];
    let targetUrl = null;

    // 优先找中文字幕（ai-zh, zh-CN, zh-Hans等）
    const zhItem = slFromState.find(s => s.lan && s.lan.includes("zh"));
    const firstItem = slFromState[0];
    const chosen = zhItem || firstItem;

    if (chosen && chosen.subtitle_url) {
      targetUrl = chosen.subtitle_url;
    }

    // 方法2: 从page_bridge获取字幕URL（拦截播放器请求 或 wbi签名主动获取）
    // page_bridge在MAIN世界执行wbi签名，结果写入data-subtitle-url
    if (!targetUrl) {
      for (let wait = 0; wait < 8000 && !targetUrl; wait += 500) {
        const bridge = document.getElementById("__bt_state_bridge");
        const intercepted = bridge?.getAttribute("data-subtitle-url");
        if (intercepted) {
          console.log("[BiliTracker] 从page_bridge获取到字幕URL");
          targetUrl = intercepted;
          break;
        }
        if (wait === 0) console.log("[BiliTracker] 等待page_bridge获取字幕URL...");
        await new Promise(r => setTimeout(r, 500));
      }
      if (!targetUrl) console.warn("[BiliTracker] 8秒内未获取到字幕URL");
    }

    if (!targetUrl) return null;
    console.log("[BiliTracker] 字幕URL获取成功:", targetUrl.substring(0, 80) + "...");
    if (targetUrl.startsWith("//")) targetUrl = "https:" + targetUrl;
    if (!targetUrl.startsWith("http")) targetUrl = "https:" + targetUrl;

    try {
      const r = await fetch(targetUrl);
      const d = await r.json();
      const body = d.body || [];
      if (body.length === 0) return null;
      const result = {
        full_text: body.map(i => i.content).join(""),
        timeline_json: body.map(i => ({ from: i.from, to: i.to, text: i.content }))
      };
      state.subtitleExtracted = true;
      state.subtitleData = result;
      updateStatusLights();

      // 立即上报视频+字幕数据到Server（不等页面卸载）
      try {
        const videoData = extractVideoData();
        fetch(`${SERVER}/api/record`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video: videoData,
            subtitle: result,
            watch: {
              bv_id: state.bvId,
              opened_at: state.openedAt,
              duration_sec: 0,
              play_progress: 0,
              play_seconds: 0,
              completed: 0,
              max_speed: 1.0,
              speed_changes: [],
              is_fullscreen: 0,
              is_autoplay: 0,
              referrer_url: document.referrer || null,
              referrer_type: getReferrerType(),
              screen_width: screen.width,
              screen_height: screen.height,
            }
          })
        });
      } catch {}

      return result;
    } catch (e) {
      console.warn("[BiliTracker] 字幕下载失败:", e);
      return null;
    }
  }

  // ── 播放器事件 ──
  function bindPlayerEvents() {
    const video = document.querySelector("video");
    if (!video) return;
    video.addEventListener("ratechange", () => {
      const s = video.playbackRate;
      state.speedChanges.push({ t: Math.round(video.currentTime), s });
      if (s > state.maxSpeed) state.maxSpeed = s;
      updateSpeedHighlight();
    });
    video.addEventListener("ended", () => { state.completed = true; });
    video.addEventListener("timeupdate", () => {
      if (Date.now() - state.lastProgressUpdate > 5000) {
        state.playSeconds = Math.round(video.currentTime);
        state.lastProgressUpdate = Date.now();
      }
    });
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) state.isFullscreen = true;
    });
  }

  // ── Tab可见性 ──
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.tabVisible) { state.tabVisibleTotal += Date.now() - state.tabVisibleStart; state.tabVisible = false; }
    } else { state.tabVisibleStart = Date.now(); state.tabVisible = true; }
  });

  // ── 连播检测 ──
  let lastNavTime = Date.now();
  function checkAutoplay() {
    const nid = extractBvId();
    if (nid && nid !== state.bvId) {
      sendData();
      const elapsed = Date.now() - lastNavTime;
      if (elapsed < 5000) {
        if (!state.autoplaySession) { state.autoplaySession = crypto.randomUUID(); state.autoplayIndex = 1; }
        state.autoplayIndex++; state.isAutoplay = true;
      } else { state.autoplaySession = null; state.autoplayIndex = 0; state.isAutoplay = false; }
      Object.assign(state, {
        bvId: nid, openedAt: new Date().toISOString(),
        speedChanges: [], maxSpeed: 1.0, isFullscreen: false, playSeconds: 0, completed: false,
        tabVisibleStart: Date.now(), tabVisibleTotal: 0, tabVisible: !document.hidden,
        sent: false, subtitleExtracted: false, subtitleData: null, hasSubtitle: false,
      });
      lastNavTime = Date.now();
      setTimeout(init, 1000);
    }
  }
  const origPush = history.pushState;
  history.pushState = function () { origPush.apply(this, arguments); setTimeout(checkAutoplay, 500); };
  window.addEventListener("popstate", () => setTimeout(checkAutoplay, 500));

  // ── 数据上报 ──
  async function sendData() {
    if (state.sent || !state.bvId) return;
    state.sent = true;
    if (state.tabVisible) state.tabVisibleTotal += Date.now() - state.tabVisibleStart;
    const video = document.querySelector("video");
    const videoData = extractVideoData();
    if (!state.subtitleData && state.hasSubtitle) await extractSubtitle();
    const payload = {
      video: videoData, subtitle: state.subtitleData,
      watch: {
        bv_id: state.bvId, opened_at: state.openedAt, closed_at: new Date().toISOString(),
        duration_sec: Math.round((Date.now() - new Date(state.openedAt).getTime()) / 1000),
        part_number: parseInt(new URLSearchParams(location.search).get("p") || "1"),
        part_title: null,
        play_progress: video ? (video.duration ? video.currentTime / video.duration : 0) : 0,
        play_seconds: video ? Math.round(video.currentTime) : state.playSeconds,
        completed: state.completed ? 1 : 0, max_speed: state.maxSpeed, speed_changes: state.speedChanges,
        is_fullscreen: state.isFullscreen ? 1 : 0,
        is_autoplay: state.isAutoplay ? 1 : 0,
        autoplay_session: state.autoplaySession, autoplay_index: state.autoplayIndex || null,
        referrer_url: document.referrer || null, referrer_type: getReferrerType(),
        search_keyword: getSearchKeyword(),
        tab_visible_sec: Math.round(state.tabVisibleTotal / 1000),
        snapshot_views: videoData.view_count, snapshot_likes: videoData.like_count,
        screen_width: screen.width, screen_height: screen.height,
      }
    };
    try { chrome.runtime.sendMessage({ type: "RECORD", data: payload }); } catch (e) { console.warn("[BT]", e); }
  }
  window.addEventListener("beforeunload", sendData);
  document.addEventListener("visibilitychange", () => { if (document.hidden) sendData(); });

  // ══════════════════════════════════════
  // UI
  // ══════════════════════════════════════
  function injectControlPanel() {
    const panel = document.createElement("div");
    panel.id = "bt-panel";
    panel.innerHTML = `
      <div class="bt-speed-grid">
        ${SPEEDS.map(s => `<div class="bt-sg" data-speed="${s}">${s}x</div>`).join("")}
      </div>
      <div class="bt-status-row">
        <div class="bt-light bt-gray" id="bt-light-server" title="Server"></div>
        <div class="bt-light bt-gray" id="bt-light-sub" title="字幕"></div>
        <div class="bt-balance" id="bt-balance" title="API余额">--</div>
      </div>
      <div class="bt-action-row">
        <div class="bt-gensub-btn hidden" id="bt-gensub" title="生成字幕（语音转写）">字幕</div>
        <div class="bt-summary-btn" id="bt-summary" title="AI总结">总结</div>
      </div>
    `;
    document.body.appendChild(panel);

    // 倍速矩阵: 直接点击
    panel.querySelectorAll(".bt-sg").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const video = document.querySelector("video");
        if (!video) return;
        video.playbackRate = parseFloat(btn.dataset.speed);
      });
    });

    // 总结
    document.getElementById("bt-summary").addEventListener("click", async (e) => {
      e.stopPropagation();
      await triggerSummary();
    });

    // 生成字幕
    document.getElementById("bt-gensub").addEventListener("click", async (e) => {
      e.stopPropagation();
      await triggerGenSub();
    });
  }

  function updateSpeedHighlight() {
    const video = document.querySelector("video");
    if (!video) return;
    const current = video.playbackRate;
    document.querySelectorAll(".bt-sg").forEach(btn => {
      const s = parseFloat(btn.dataset.speed);
      btn.classList.toggle("bt-sg-active", s === current);
    });
  }

  function updateStatusLights() {
    const sL = document.getElementById("bt-light-server");
    const uL = document.getElementById("bt-light-sub");
    if (!sL || !uL) return;
    sL.className = "bt-light " + (state.serverConnected ? "bt-green" : "bt-red");
    sL.title = state.serverConnected ? "Server已连接" : "Server未连接";
    const genBtn = document.getElementById("bt-gensub");
    if (state.subtitleExtracted) {
      uL.className = "bt-light bt-green"; uL.title = "字幕已提取 ✓";
      if (genBtn) genBtn.classList.add("hidden");
    } else if (state.hasSubtitle) {
      uL.className = "bt-light bt-yellow"; uL.title = "有字幕，提取中...";
      if (genBtn) genBtn.classList.add("hidden");
    } else {
      uL.className = "bt-light bt-gray"; uL.title = "无字幕";
      // 自动转写开启时隐藏手动按钮
      if (genBtn) genBtn.classList.toggle("hidden", state.autoAsr);
    }
  }

  // ── 总结 ──
  async function triggerSummary() {
    const btn = document.getElementById("bt-summary");
    if (!btn || !state.bvId) return;
    if (!state.serverConnected) { showToast("Server未连接，请先启动 python server.py", "error"); return; }
    btn.textContent = "..."; btn.classList.add("bt-loading");
    if (!state.subtitleExtracted && !state.hasSubtitle) showToast("无字幕，尝试语音转写...", "info");
    try {
      const r = await fetch(`${SERVER}/api/summarize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bv_id: state.bvId })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg = err.detail || `失败 (${r.status})`;
        if (r.status === 501) showToast("请设置 DEEPSEEK_API_KEY 环境变量", "error");
        else if (/余额|balance|quota|insufficient/i.test(msg)) showToast("API余额不足，请充值", "error");
        else showToast(msg, "error");
        return;
      }
      // 流式接收
      showSummaryPanel('');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.error) { showToast('错误: ' + d.error, 'error'); break; }
            if (d.delta) appendSummaryPanel(d.delta);
            if (d.done) fetchBalance();
          } catch {}
        }
      }
    } catch (e) { showToast("请求失败: " + e.message, "error"); }
    finally { btn.textContent = "总结"; btn.classList.remove("bt-loading"); }
  }

  // ── 生成字幕（ASR）──
  async function triggerGenSub() {
    const btn = document.getElementById("bt-gensub");
    if (!btn || !state.bvId) return;
    if (!state.serverConnected) { showToast("Server未连接", "error"); return; }
    btn.textContent = "转写中..."; btn.classList.add("bt-loading");
    const uL = document.getElementById("bt-light-sub");
    if (uL) { uL.className = "bt-light bt-yellow"; uL.title = "转写中..."; }
    try {
      const r = await fetch(`${SERVER}/api/extract_subtitle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bv_id: state.bvId })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast(err.detail || "字幕生成失败", "error");
        if (uL) { uL.className = "bt-light bt-gray"; uL.title = "无字幕"; }
        return;
      }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.error) { showToast('错误: ' + d.error, 'error'); if (uL) { uL.className = "bt-light bt-gray"; uL.title = "无字幕"; } return; }
            if (d.progress) { btn.textContent = d.progress.slice(0, 6) + '...'; }
            if (d.done) {
              state.subtitleExtracted = true;
              if (uL) { uL.className = "bt-light bt-green"; uL.title = "字幕已生成 ✓"; }
              btn.classList.add("hidden");
              showToast(`字幕生成完成（${d.char_count || ''}字）`, "info");
            }
          } catch {}
        }
      }
    } catch (e) {
      showToast("请求失败: " + e.message, "error");
      if (uL) { uL.className = "bt-light bt-gray"; uL.title = "无字幕"; }
    } finally {
      btn.textContent = "字幕"; btn.classList.remove("bt-loading");
    }
  }

  function showSummaryPanel(text) {
    let p = document.getElementById("bt-summary-panel");
    if (!p) {
      p = document.createElement("div"); p.id = "bt-summary-panel";
      p.innerHTML = `<div class="bt-sp-header"><span>AI 总结</span><span class="bt-sp-close" id="bt-sp-close">✕</span></div><div class="bt-sp-body" id="bt-sp-body"></div>`;
      document.body.appendChild(p);
      document.getElementById("bt-sp-close").addEventListener("click", () => p.classList.remove("bt-sp-show"));
    }
    document.getElementById("bt-sp-body").textContent = text;
    p.classList.add("bt-sp-show");
  }

  function appendSummaryPanel(delta) {
    const body = document.getElementById("bt-sp-body");
    if (body) body.textContent += delta;
  }

  function showToast(msg, type = "info") {
    const t = document.createElement("div");
    t.className = `bt-toast bt-toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("bt-toast-show"));
    setTimeout(() => { t.classList.remove("bt-toast-show"); setTimeout(() => t.remove(), 300); }, 3500);
  }

  // ── 初始化 ──
  async function init() {
    state.bvId = extractBvId();
    if (!state.bvId) return;
    // 清除缓存，等待page_bridge.js写入新数据
    window.__bt_cached_state = null;

    // 等待bridge元素就绪（page_bridge.js可能还没执行完）
    let waited = 0;
    while (!document.getElementById("__bt_state_bridge") && waited < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    await checkServer();
    extractVideoData();
    await extractSubtitle();

    // 如果字幕没提取到但视频有字幕，延迟重试
    if (!state.subtitleExtracted && state.hasSubtitle) {
      setTimeout(async () => {
        window.__bt_cached_state = null;
        await extractSubtitle();
      }, 5000);
    }

    const wi = setInterval(() => {
      const v = document.querySelector("video");
      if (v) { clearInterval(wi); bindPlayerEvents(); updateSpeedHighlight(); }
    }, 500);
    setTimeout(() => clearInterval(wi), 30000);
    setInterval(checkServer, 60000);
    setInterval(fetchBalance, 30000);
  }

  // ── 侧边栏通信 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_VIDEO_INFO") {
      sendResponse({
        bvId: state.bvId,
        hasSubtitle: state.hasSubtitle,
        subtitleExtracted: state.subtitleExtracted,
        serverConnected: state.serverConnected,
        videoData: extractVideoData(),
      });
      return true;
    }
    if (msg.type === "FORCE_UPLOAD") {
      state.sent = false;
      sendData().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "SUBTITLE_READY") {
      state.subtitleExtracted = true;
      updateStatusLights();
      sendResponse({ ok: true });
      return true;
    }
  });

  setTimeout(() => {
    if (!document.getElementById("bt-panel")) injectControlPanel();
    init();
  }, 2000);
})();
