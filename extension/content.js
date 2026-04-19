/**
 * BiliTracker Content Script v1.3.0
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
    autoAsr: true,
    asrRunning: false,
  };

  let _checkServerInterval = null;
  let _fetchBalanceInterval = null;

  // ── 工具函数 ──
  function extractBvId() {
    const m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  }

  function getInitialState() {
    const currentBv = extractBvId();
    if (!currentBv) return null;
    const bridge = document.getElementById("__bt_state_bridge");
    if (bridge?.getAttribute("data-ready") === "1") {
      try {
        const d = JSON.parse(bridge.textContent);
        if (d.videoData?.bvid === currentBv) return d;
      } catch {}
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

  // ── 等待 bridge 包含指定 bvId 的数据（MutationObserver，响应及时，无轮询开销）──
  function waitForBridge(targetBv, timeout = 15000) {
    return new Promise(resolve => {
      let settled = false;
      let bridgeObs = null;

      const done = (val) => {
        if (settled) return;
        settled = true;
        bodyObs.disconnect();
        bridgeObs?.disconnect();
        clearTimeout(timer);
        resolve(val);
      };

      const checkBridge = () => {
        const bridge = document.getElementById("__bt_state_bridge");
        if (!bridge) return;
        if (!bridgeObs) {
          bridgeObs = new MutationObserver(checkBridge);
          bridgeObs.observe(bridge, {
            characterData: true, subtree: true,
            attributes: true, attributeFilter: ["data-ready"]
          });
        }
        if (bridge.getAttribute("data-ready") !== "1") return;
        try {
          if (JSON.parse(bridge.textContent).videoData?.bvid === targetBv) done(true);
        } catch {}
      };

      const bodyObs = new MutationObserver(checkBridge);
      bodyObs.observe(document.body, { childList: true });

      const timer = setTimeout(() => done(false), timeout);
      checkBridge();
    });
  }

  // ── Server检测 + 余额 ──
  async function checkServer() {
    try {
      const r = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(2000) });
      state.serverConnected = r.ok;
      if (r.ok) {
        const d = await r.json();
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
      try {
        const sr = await fetch(`${SERVER}/api/settings`, { signal: AbortSignal.timeout(2000) });
        if (sr.ok) { const s = await sr.json(); state.autoAsr = s.auto_asr !== false; }
      } catch {}
    }
    updateStatusLights();
    return state.serverConnected;
  }

  function fetchBalance() {
    chrome.runtime.sendMessage({ type: "GET_BALANCE" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.cache) return;
      const d = resp.cache;
      const el = document.getElementById("bt-balance");
      if (!el || d.total_balance == null) return;
      el.textContent = `¥${d.total_balance}`;
      el.title = `充值: ¥${d.topped_up} | 赠送: ¥${d.granted}`;
      el.className = "bt-balance" + (parseFloat(d.total_balance) < 1 ? " bt-low" : "");
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
  // 优先从 __INITIAL_STATE__ 读 subtitle_url；没有则用 MutationObserver 等待
  // page_bridge.js 主动获取后写入 data-subtitle-url 属性，observer 立即响应
  async function extractSubtitle() {
    const ini = getInitialState();
    const vd = ini?.videoData || {};
    const bvid = vd.bvid || extractBvId();
    const cid = vd.cid || vd.pages?.[0]?.cid;
    if (!bvid || !cid) return null;

    const slFromState = (vd.subtitle || {}).list || [];
    const chosen = slFromState.find(s => s.lan?.includes("zh")) || slFromState[0];
    let targetUrl = chosen?.subtitle_url || null;

    if (!targetUrl) {
      const bridge = document.getElementById("__bt_state_bridge");
      const existing = bridge?.getAttribute("data-subtitle-url");
      if (existing) {
        targetUrl = existing;
      } else if (bridge) {
        console.log("[BiliTracker] 等待page_bridge获取字幕URL...");
        targetUrl = await new Promise(resolve => {
          const obs = new MutationObserver(() => {
            const url = bridge.getAttribute("data-subtitle-url");
            if (url) { obs.disconnect(); resolve(url); }
          });
          obs.observe(bridge, { attributes: true, attributeFilter: ["data-subtitle-url"] });
          setTimeout(() => { obs.disconnect(); resolve(null); }, 10000);
        });
      }
    }

    if (!targetUrl) { console.warn("[BiliTracker] 未获取到字幕URL"); return null; }
    console.log("[BiliTracker] 字幕URL:", targetUrl.substring(0, 80));
    if (targetUrl.startsWith("//")) targetUrl = "https:" + targetUrl;
    else if (!targetUrl.startsWith("http")) targetUrl = "https:" + targetUrl;

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

      try {
        const videoData = extractVideoData();
        fetch(`${SERVER}/api/record`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video: videoData, subtitle: result,
            watch: {
              bv_id: state.bvId, opened_at: state.openedAt,
              duration_sec: 0, play_progress: 0, play_seconds: 0,
              completed: 0, max_speed: 1.0, speed_changes: [],
              is_fullscreen: 0, is_autoplay: 0,
              referrer_url: document.referrer || null,
              referrer_type: getReferrerType(),
              screen_width: screen.width, screen_height: screen.height,
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

  // ── 键盘快捷键: Shift+1~6 对应 SPEEDS[0~5] ──
  // 用 e.code（"Digit1"~"Digit6"）而非 e.key：按住 Shift 时 e.key 是 !@#$%^ 不是数字
  document.addEventListener("keydown", (e) => {
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!e.code.startsWith("Digit")) return;
    const idx = parseInt(e.code.slice(5)) - 1;
    if (idx < 0 || idx >= SPEEDS.length) return;
    const video = document.querySelector("video");
    if (!video) return;
    e.preventDefault();
    video.playbackRate = SPEEDS[idx];
  });

  // ── 播放器事件 ──
  function bindPlayerEvents() {
    const video = document.querySelector("video");
    if (!video || video.__bt_bound) return;
    video.__bt_bound = true;
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
  }

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) state.isFullscreen = true;
  });

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
      try { chrome.runtime.sendMessage({ type: "VIDEO_CHANGED", bvId: nid }); } catch {}
      setTimeout(init, 1000);
    }
  }

  // ── SPA 导航检测 ──
  // history.pushState hook 写在 ISOLATED world，无法拦截 MAIN world（Bilibili 路由器）的调用。
  // page_bridge.js 运行在 MAIN world，轮询 location.href，检测到新视频时更新 bridge。
  // 此 observer 持续监听 bridge bvid 变化，作为可靠的导航信号源。
  function startNavigationWatch() {
    let bridgeObs = null;

    const checkBvChange = () => {
      const bridge = document.getElementById("__bt_state_bridge");
      if (!bridge || bridge.getAttribute("data-ready") !== "1") return;
      try {
        const bvid = JSON.parse(bridge.textContent).videoData?.bvid;
        if (bvid && bvid !== state.bvId) checkAutoplay();
      } catch {}
    };

    const attachToBridge = (bridge) => {
      bridgeObs?.disconnect();
      bridgeObs = new MutationObserver(checkBvChange);
      bridgeObs.observe(bridge, {
        characterData: true, subtree: true,
        attributes: true, attributeFilter: ["data-ready"]
      });
    };

    // 监听 bridge 元素首次出现（第一次页面加载时 bridge 尚不存在）
    const bodyObs = new MutationObserver(() => {
      const bridge = document.getElementById("__bt_state_bridge");
      if (bridge) { attachToBridge(bridge); checkBvChange(); }
    });
    bodyObs.observe(document.body, { childList: true });

    // 若 bridge 已存在（SPA 场景 content script 持续运行），直接绑定
    const existing = document.getElementById("__bt_state_bridge");
    if (existing) attachToBridge(existing);
  }

  // popstate 用于浏览器前进/后退（此事件在 isolated world 中可靠触发）
  window.addEventListener("popstate", () => setTimeout(checkAutoplay, 500));

  // ── 数据上报 ──
  async function sendData() {
    if (state.sent || !state.bvId) return;
    state.sent = true;
    // 在任何 await 前快照所有状态，防止导航切换后 state 被 checkAutoplay 重置
    const snap = {
      bvId: state.bvId, openedAt: state.openedAt, subtitleData: state.subtitleData,
      hasSubtitle: state.hasSubtitle, completed: state.completed, maxSpeed: state.maxSpeed,
      speedChanges: state.speedChanges.slice(), isFullscreen: state.isFullscreen,
      isAutoplay: state.isAutoplay, autoplaySession: state.autoplaySession,
      autoplayIndex: state.autoplayIndex, playSeconds: state.playSeconds,
    };
    if (state.tabVisible) state.tabVisibleTotal += Date.now() - state.tabVisibleStart;
    const tabVisibleTotal = state.tabVisibleTotal;
    const video = document.querySelector("video");
    const videoData = extractVideoData();
    if (!snap.subtitleData && snap.hasSubtitle) await extractSubtitle();
    const subtitleData = snap.subtitleData || state.subtitleData;
    const payload = {
      video: videoData, subtitle: subtitleData,
      watch: {
        bv_id: snap.bvId, opened_at: snap.openedAt, closed_at: new Date().toISOString(),
        duration_sec: Math.round((Date.now() - new Date(snap.openedAt).getTime()) / 1000),
        part_number: parseInt(new URLSearchParams(location.search).get("p") || "1"),
        part_title: null,
        play_progress: video ? (video.duration ? video.currentTime / video.duration : 0) : 0,
        play_seconds: video ? Math.round(video.currentTime) : snap.playSeconds,
        completed: snap.completed ? 1 : 0, max_speed: snap.maxSpeed, speed_changes: snap.speedChanges,
        is_fullscreen: snap.isFullscreen ? 1 : 0, is_autoplay: snap.isAutoplay ? 1 : 0,
        autoplay_session: snap.autoplaySession, autoplay_index: snap.autoplayIndex || null,
        referrer_url: document.referrer || null, referrer_type: getReferrerType(),
        search_keyword: getSearchKeyword(),
        tab_visible_sec: Math.round(tabVisibleTotal / 1000),
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

    panel.querySelectorAll(".bt-sg").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const video = document.querySelector("video");
        if (!video) return;
        video.playbackRate = parseFloat(btn.dataset.speed);
      });
    });
    document.getElementById("bt-summary").addEventListener("click", async (e) => {
      e.stopPropagation();
      await triggerSummary();
    });
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
      btn.classList.toggle("bt-sg-active", parseFloat(btn.dataset.speed) === current);
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
    } else if (state.asrRunning) {
      uL.className = "bt-light bt-asr"; uL.title = "转写中...";
      if (genBtn) genBtn.classList.add("hidden");
    } else if (state.hasSubtitle) {
      uL.className = "bt-light bt-yellow"; uL.title = "有字幕，提取中...";
      if (genBtn) genBtn.classList.add("hidden");
    } else {
      uL.className = "bt-light bt-gray"; uL.title = "无字幕";
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

  // ── 自动 ASR（无侧边栏时后台触发）──
  async function autoTriggerAsr() {
    if (!state.autoAsr || !state.bvId || !state.serverConnected) return;
    if (state.hasSubtitle || state.subtitleExtracted) return;

    try {
      const r = await fetch(`${SERVER}/api/video/${state.bvId}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const v = await r.json();
        if (v.subtitle_in_db) { state.subtitleExtracted = true; updateStatusLights(); return; }
      }
    } catch {}

    state.asrRunning = true;
    updateStatusLights();
    try {
      const r = await fetch(`${SERVER}/api/extract_subtitle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bv_id: state.bvId })
      });
      if (!r.ok) return;
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.done) {
              state.subtitleExtracted = true;
              if (d.char_count) showToast(`字幕自动转写完成（${d.char_count}字）`, "info");
            }
          } catch {}
        }
      }
    } catch {}
    state.asrRunning = false;
    updateStatusLights();
  }

  // ── 生成字幕（ASR）──
  async function triggerGenSub() {
    const btn = document.getElementById("bt-gensub");
    if (!btn || !state.bvId) return;
    if (!state.serverConnected) { showToast("Server未连接", "error"); return; }
    btn.textContent = "转写中..."; btn.classList.add("bt-loading");
    state.asrRunning = true;
    updateStatusLights();
    try {
      const r = await fetch(`${SERVER}/api/extract_subtitle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bv_id: state.bvId })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast(err.detail || "字幕生成失败", "error");
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
            if (d.error) { showToast('错误: ' + d.error, 'error'); return; }
            if (d.progress) { btn.textContent = d.progress.slice(0, 6) + '...'; }
            if (d.done) {
              state.subtitleExtracted = true;
              btn.classList.add("hidden");
              showToast(`字幕生成完成（${d.char_count || ''}字）`, "info");
            }
          } catch {}
        }
      }
    } catch (e) {
      showToast("请求失败: " + e.message, "error");
    } finally {
      state.asrRunning = false;
      updateStatusLights();
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
    const targetBv = state.bvId;

    // 等待 page_bridge.js 将当前视频数据写入 bridge 元素（MutationObserver，立即响应）
    await waitForBridge(targetBv);

    // 等待期间若发生新导航，放弃本次 init（新导航会重新调用 init）
    if (state.bvId !== targetBv) return;

    await checkServer();
    extractVideoData();
    await extractSubtitle();

    if (!state.subtitleExtracted && !state.hasSubtitle) {
      setTimeout(() => autoTriggerAsr(), 1000);
    }

    // 等待 video 元素（MutationObserver，不需要固定等待时间）
    const v = document.querySelector("video");
    if (v) {
      bindPlayerEvents();
      updateSpeedHighlight();
    } else {
      const obs = new MutationObserver(() => {
        const vid = document.querySelector("video");
        if (vid) { obs.disconnect(); bindPlayerEvents(); updateSpeedHighlight(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    if (_checkServerInterval) clearInterval(_checkServerInterval);
    _checkServerInterval = setInterval(checkServer, 60000);
    if (_fetchBalanceInterval) clearInterval(_fetchBalanceInterval);
    _fetchBalanceInterval = setInterval(fetchBalance, 30000);
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

  // 内容脚本在 document_idle 运行，body 必然存在，直接启动
  if (!document.getElementById("bt-panel")) injectControlPanel();
  init();
  startNavigationWatch();
})();
