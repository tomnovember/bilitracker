/**
 * BiliTracker Background Service Worker
 * 数据缓冲 + sidePanel管理
 */

const SERVER_URL = "http://localhost:9876";

// ── 余额缓存（单一数据源，content.js / sidebar.js 都从这里读）──
const balanceCache = {
  data: null,
  error: null,
  ts: 0,
};

async function refreshBalance() {
  try {
    const r = await fetch(`${SERVER_URL}/api/balance`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const d = await r.json();
    if (d.error) { balanceCache.error = d.error; return; }
    const newVal = parseFloat(d.total_balance);
    if (newVal === 0 && balanceCache.data && parseFloat(balanceCache.data.total_balance) > 0) return;
    balanceCache.data = d;
    balanceCache.error = null;
    balanceCache.ts = Date.now();
  } catch {}
}

refreshBalance();
setInterval(refreshBalance, 30000);

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── ASR 队列 ──
let bgAutoAsr = true;
let bgWhisperModel = 'large-v3-turbo';
const bgAsrQueue = [];
let bgAsrBusy = false;
let bgAsrCurrentBv = null;

// ── 总结队列 ──
const bgSummQueue = []; // { bvId, model, whisperModel, force }
let bgSummBusy = false;
let bgSummCurrentBv = null;
let bgSummFullText = '';
let bgSummAsrActive = false; // SUMM 内部是否正在执行 ASR（影响字幕状态计算）

async function bgRefreshSettings() {
  try {
    const r = await fetch(`${SERVER_URL}/api/settings`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const s = await r.json();
      bgAutoAsr = s.auto_asr !== false;
      bgWhisperModel = s.whisper_model || 'large-v3-turbo';
    }
  } catch {}
}
bgRefreshSettings();

// 找到正在播放 bvId 的 tab
function bgFindTab(bvId, callback) {
  chrome.tabs.query({ url: `*://www.bilibili.com/video/${bvId}*` }, tabs => callback(tabs[0] || null));
}

// 向所有扩展页（sidebar）广播
function bgBroadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── 字幕状态纯函数：队列状态优先，再看服务器数据 ──
function bgComputeSubStatus(bvId, v) {
  if (bgAsrCurrentBv === bvId) return { cls: 'bt-asr',    title: '转写中...',   showGenBtn: false };
  if (bgAsrQueue.includes(bvId)) return { cls: 'bt-yellow', title: '排队中...',   showGenBtn: false };
  if (bgSummCurrentBv === bvId && bgSummAsrActive) return { cls: 'bt-asr', title: '转写中...', showGenBtn: false };
  if (!v) return null;
  if (v.subtitle_in_db) return { cls: 'bt-green',  title: '字幕已提取 ✓', showGenBtn: false };
  if (v.has_subtitle)   return { cls: 'bt-yellow', title: '自带字幕',     showGenBtn: false };
  return                       { cls: 'bt-gray',   title: '无字幕',       showGenBtn: true  };
}

// ── 推送字幕状态：悬浮窗 + sidebar 同步双推 ──
function bgPushStatus(bvId, v) {
  const s = bgComputeSubStatus(bvId, v);
  if (!s) return;
  bgFindTab(bvId, tab => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SUB_STATUS', cls: s.cls, title: s.title, showGenBtn: s.showGenBtn }).catch(() => {});
  });
  bgBroadcast({ type: 'SUB_STATUS', bvId, cls: s.cls, title: s.title, showGenBtn: s.showGenBtn, videoInfo: v || null });
}

// ── 查询服务器后推送（用于视频加载、队列完成、tab切换等场景）──
async function bgQueryAndPush(bvId) {
  try {
    const r = await fetch(`${SERVER_URL}/api/video/${bvId}`, { signal: AbortSignal.timeout(3000) });
    const v = r.ok ? await r.json() : null;
    bgPushStatus(bvId, v);
    return v;
  } catch {
    bgPushStatus(bvId, null);
    return null;
  }
}

// ── ASR 队列管理 ──
function bgEnqueue(bvId) {
  if (bgAsrCurrentBv === bvId) {
    bgBroadcast({ type: 'ASR_STATE', busy: bgAsrBusy, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
    return;
  }
  const idx = bgAsrQueue.indexOf(bvId);
  if (idx > -1) bgAsrQueue.splice(idx, 1);
  bgAsrQueue.unshift(bvId);
  if (bgAsrQueue.length > 50) bgAsrQueue.length = 50;
  bgBroadcast({ type: 'ASR_STATE', busy: bgAsrBusy, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
  bgPushStatus(bvId, null); // 立即推送排队状态（不需要查服务器）
  bgProcessQueue();
}

async function bgProcessQueue() {
  if (bgAsrBusy) return;
  while (bgAsrQueue.length > 0) {
    bgAsrBusy = true;
    bgAsrCurrentBv = bgAsrQueue.shift();
    await bgRefreshSettings();
    bgBroadcast({ type: 'ASR_STATE', busy: true, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
    bgPushStatus(bgAsrCurrentBv, null); // 队列状态 → 转写中

    const bv = bgAsrCurrentBv;
    const asrController = new AbortController();
    const asrAbortTimer = setTimeout(() => asrController.abort(), 3 * 60 * 60 * 1000);
    try {
      const r = await fetch(`${SERVER_URL}/api/extract_subtitle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bv_id: bv, whisper_model: bgWhisperModel, keep_audio: false }),
        signal: asrController.signal
      });
      if (!r.ok) throw new Error('request failed');

      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.error) {
              bgBroadcast({ type: 'ASR_PROGRESS', bvId: bv, error: d.error });
              streamDone = true; break;
            }
            if (d.progress) bgBroadcast({ type: 'ASR_PROGRESS', bvId: bv, progress: d.progress });
            if (d.done) {
              bgFindTab(bv, tab => {
                if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SUBTITLE_READY' }).catch(() => {});
              });
              bgBroadcast({ type: 'ASR_PROGRESS', bvId: bv, done: true, charCount: d.char_count });
              streamDone = true; break;
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') bgBroadcast({ type: 'ASR_PROGRESS', bvId: bv, error: e?.message || '未知错误' });
    } finally {
      clearTimeout(asrAbortTimer);
    }

    bgAsrBusy = false;
    bgAsrCurrentBv = null;
    bgBroadcast({ type: 'ASR_STATE', busy: false, currentBv: null, queue: [...bgAsrQueue] });
    bgQueryAndPush(bv); // 队列清空，查服务器获取最终状态（含字数）
  }
}

// ── SUMM 队列管理 ──
function bgEnqueueSumm(bvId, model, whisperModel, force) {
  if (bgSummCurrentBv === bvId) {
    bgBroadcast({ type: 'SUMM_STATE', busy: bgSummBusy, currentBv: bgSummCurrentBv, queue: bgSummQueue.map(i => i.bvId) });
    return;
  }
  const idx = bgSummQueue.findIndex(i => i.bvId === bvId);
  if (idx > -1) bgSummQueue.splice(idx, 1);
  bgSummQueue.unshift({ bvId, model: model || null, whisperModel: whisperModel || null, force: !!force });
  if (bgSummQueue.length > 20) bgSummQueue.length = 20;
  bgBroadcast({ type: 'SUMM_STATE', busy: bgSummBusy, currentBv: bgSummCurrentBv, queue: bgSummQueue.map(i => i.bvId) });
  bgProcessSummQueue();
}

async function bgProcessSummQueue() {
  if (bgSummBusy) return;
  while (bgSummQueue.length > 0) {
    bgSummBusy = true;
    const item = bgSummQueue.shift();
    bgSummCurrentBv = item.bvId;
    bgSummFullText = '';
    bgSummAsrActive = false;
    bgBroadcast({ type: 'SUMM_STATE', busy: true, currentBv: bgSummCurrentBv, queue: bgSummQueue.map(i => i.bvId) });
    bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bgSummCurrentBv, progress: '准备中...' });

    const bv = bgSummCurrentBv;
    const summController = new AbortController();
    const summAbortTimer = setTimeout(() => summController.abort(), 20 * 60 * 1000);
    try {
      const body = { bv_id: bv };
      if (item.model) body.model = item.model;
      if (item.whisperModel) body.whisper_model = item.whisperModel;
      if (item.force) body.force = true;

      const r = await fetch(`${SERVER_URL}/api/summarize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: summController.signal
      });

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, error: e.detail || `失败 (${r.status})` });
      } else {
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        let streamDone = false;
        while (!streamDone) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const d = JSON.parse(line.slice(6));
              if (d.error) {
                bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, error: d.error });
                streamDone = true; break;
              }
              if (d.progress) {
                const asrActive = ['下载音频', '加载 Whisper', '转写音频'].some(k => d.progress.includes(k));
                if (asrActive && !bgSummAsrActive) {
                  bgSummAsrActive = true;
                  bgPushStatus(bv, null); // SUMM 内部 ASR 开始，字幕灯更新为转写中
                }
                bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, progress: d.progress, asrActive });
              }
              if (d.delta) {
                bgSummFullText += d.delta;
                bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, delta: d.delta });
              }
              if (d.done) {
                bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, done: true, fullText: bgSummFullText });
                streamDone = true; break;
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') bgBroadcast({ type: 'SUMM_PROGRESS', bvId: bv, error: e?.message || '未知错误' });
    } finally {
      clearTimeout(summAbortTimer);
    }

    bgSummBusy = false;
    bgSummCurrentBv = null;
    bgSummAsrActive = false;
    bgBroadcast({ type: 'SUMM_STATE', busy: false, currentBv: null, queue: bgSummQueue.map(i => i.bvId) });
    bgQueryAndPush(bv); // 队列清空，查服务器获取最终状态
  }
}

// 接收消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RECORD") {
    sendRecord(msg.data).then(result => {
      sendResponse(result);
      // 字幕刚写入 DB，立即推送最新状态
      const bvId = msg.data?.video?.bv_id;
      if (bvId && msg.data?.subtitle) bgQueryAndPush(bvId);
    }).catch(err => {
      bufferRecord(msg.data);
      sendResponse({ status: "buffered", error: err.message });
    });
    return true;
  }

  if (msg.type === "CHECK_SERVER") {
    checkServer().then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === "GET_BALANCE") {
    sendResponse({ cache: balanceCache.data, error: balanceCache.error, ts: balanceCache.ts });
    return false;
  }

  if (msg.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: SERVER_URL });
    return false;
  }

  if (msg.type === "FORCE_UPLOAD") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "FORCE_UPLOAD" }, (response) => {
          sendResponse(response || { ok: true });
        });
      } else {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  if (msg.type === "ENQUEUE_ASR" || msg.type === "TRIGGER_ASR") {
    if (msg.bvId) bgEnqueue(msg.bvId);
    sendResponse({});
    return true;
  }

  // 视频加载上报：查服务器推状态，server 本地 < 50ms
  if (msg.type === "VIDEO_STATUS") {
    const bvId = msg.bvId;
    if (!bvId) { sendResponse({}); return true; }
    bgQueryAndPush(bvId).then(v => {
      if (!v) {
        // server 无响应，用页面已知数据兜底
        if (msg.hasSubtitle) bgPushStatus(bvId, { has_subtitle: 1, subtitle_in_db: 0 });
        else if (bgAutoAsr) bgEnqueue(bvId);
      } else {
        if (v.subtitle_in_db) {
          bgFindTab(bvId, tab => {
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SUBTITLE_READY' }).catch(() => {});
          });
        } else if (!v.has_subtitle && bgAutoAsr) {
          bgEnqueue(bvId);
        }
      }
    });
    sendResponse({});
    return true;
  }

  // sidebar 查询字幕状态：触发 bgQueryAndPush，结果通过 SUB_STATUS 广播返回
  if (msg.type === "GET_SUB_STATUS") {
    if (msg.bvId) bgQueryAndPush(msg.bvId);
    sendResponse(null);
    return false;
  }

  // 总结入队；若来自悬浮窗顺带打开 sidebar
  if (msg.type === "ENQUEUE_SUMM") {
    if (msg.bvId) bgEnqueueSumm(msg.bvId, msg.model, msg.whisperModel, msg.force);
    if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    sendResponse({});
    return true;
  }

  if (msg.type === "GET_SUMM_STATE") {
    sendResponse({ busy: bgSummBusy, currentBv: bgSummCurrentBv, queue: bgSummQueue.map(i => i.bvId), fullText: bgSummFullText });
    return true;
  }

  if (msg.type === "GET_ASR_STATE") {
    sendResponse({ busy: bgAsrBusy, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
    return true;
  }

  if (msg.type === "SETTINGS_CHANGED") {
    bgRefreshSettings();
    return false;
  }

  // content.js SPA 导航：立即查询并推状态到悬浮窗 + sidebar，不等 VIDEO_STATUS（后者需 waitForBridge 后才发）
  if (msg.type === "VIDEO_CHANGED") {
    if (msg.bvId) {
      bgQueryAndPush(msg.bvId).then(v => {
        if (!v) return;
        if (v.subtitle_in_db) {
          bgFindTab(msg.bvId, tab => {
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SUBTITLE_READY' }).catch(() => {});
          });
        } else if (!v.has_subtitle && bgAutoAsr) {
          bgEnqueue(msg.bvId);
        }
      });
    }
    return false;
  }
});

// 切 tab / 切窗口：通知 sidebar 刷新 + 即时查询推送浮窗状态（不依赖缓存）
// VIDEO_CHANGED 带上 bvId，sidebar 立即更新 currentBvId，避免早到的 SUB_STATUS 被过滤
function bgOnTabSwitch(tabId) {
  if (!tabId) { bgBroadcast({ type: 'VIDEO_CHANGED' }); return; }
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) { bgBroadcast({ type: 'VIDEO_CHANGED' }); return; }
    const m = tab.url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    const bvId = m ? m[1] : undefined;
    bgBroadcast({ type: 'VIDEO_CHANGED', bvId });
    if (bvId) bgQueryAndPush(bvId);
  });
}
chrome.tabs.onActivated.addListener((info) => bgOnTabSwitch(info.tabId));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => bgOnTabSwitch(tabs[0]?.id));
});

async function sendRecord(data) {
  const resp = await fetch(`${SERVER_URL}/api/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Server responded ${resp.status}`);
  return await resp.json();
}

async function checkServer() {
  try {
    const resp = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch { return false; }
}

function bufferRecord(data) {
  chrome.storage.local.get("pendingRecords", (result) => {
    const pending = result.pendingRecords || [];
    pending.push(data);
    chrome.storage.local.set({ pendingRecords: pending });
  });
}

chrome.storage.local.get("pendingRecords", async (result) => {
  if (result.pendingRecords?.length > 0) {
    const serverOk = await checkServer();
    if (serverOk) {
      for (const record of result.pendingRecords) {
        try { await sendRecord(record); } catch { break; }
      }
      chrome.storage.local.set({ pendingRecords: [] });
    }
  }
});
