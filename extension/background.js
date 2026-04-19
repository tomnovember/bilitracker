/**
 * BiliTracker Background Service Worker
 * 数据缓冲 + sidePanel管理
 */

const SERVER_URL = "http://localhost:9876";

// ── 余额缓存（单一数据源，content.js / sidebar.js 都从这里读）──
const balanceCache = {
  data: null,       // { total_balance, granted, topped_up, currency, is_available }
  error: null,
  ts: 0,            // 上次成功刷新的时间戳
};

async function refreshBalance() {
  try {
    const r = await fetch(`${SERVER_URL}/api/balance`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const d = await r.json();
    if (d.error) { balanceCache.error = d.error; return; }
    // 防抖：API偶尔返回0时保留上次有效值
    const newVal = parseFloat(d.total_balance);
    if (newVal === 0 && balanceCache.data && parseFloat(balanceCache.data.total_balance) > 0) return;
    balanceCache.data = d;
    balanceCache.error = null;
    balanceCache.ts = Date.now();
  } catch {}
}

// 每30秒刷新一次
refreshBalance();
setInterval(refreshBalance, 30000);

// 点击Extension图标打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── ASR 队列（常驻，无需 sidebar 打开）──
let bgAutoAsr = true;
let bgWhisperModel = 'large-v3-turbo';
const bgAsrQueue = [];
let bgAsrBusy = false;
let bgAsrCurrentBv = null;

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

// 向 bvId 对应的 tab（悬浮窗）推送字幕状态
function bgPushSubStatus(bvId, cls, title, showGenBtn) {
  bgFindTab(bvId, tab => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SUB_STATUS', cls, title, showGenBtn }).catch(() => {});
  });
}

// 向所有扩展页（sidebar）广播
function bgBroadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function bgEnqueue(bvId) {
  if (bgAsrCurrentBv === bvId) return;
  const idx = bgAsrQueue.indexOf(bvId);
  if (idx > -1) bgAsrQueue.splice(idx, 1);
  bgAsrQueue.unshift(bvId);
  if (bgAsrQueue.length > 50) bgAsrQueue.length = 50;
  bgBroadcast({ type: 'ASR_STATE', busy: bgAsrBusy, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
  bgProcessQueue();
}

async function bgProcessQueue() {
  if (bgAsrBusy) return;
  while (bgAsrQueue.length > 0) {
    bgAsrBusy = true;
    bgAsrCurrentBv = bgAsrQueue.shift();
    await bgRefreshSettings(); // 每次处理前同步最新设置
    bgBroadcast({ type: 'ASR_STATE', busy: true, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
    bgPushSubStatus(bgAsrCurrentBv, 'bt-yellow', '排队中...', false);

    try {
      const r = await fetch(`${SERVER_URL}/api/extract_subtitle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bv_id: bgAsrCurrentBv, whisper_model: bgWhisperModel, keep_audio: false })
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
              bgPushSubStatus(bgAsrCurrentBv, 'bt-gray', '转写失败', true);
              bgBroadcast({ type: 'ASR_PROGRESS', bvId: bgAsrCurrentBv, error: d.error });
              streamDone = true; break;
            }
            if (d.progress) {
              const active = ['下载音频', '加载 Whisper', '转写音频'].some(k => d.progress.includes(k));
              if (active) bgPushSubStatus(bgAsrCurrentBv, 'bt-asr', '转写中...', false);
              bgBroadcast({ type: 'ASR_PROGRESS', bvId: bgAsrCurrentBv, progress: d.progress });
            }
            if (d.done) {
              bgPushSubStatus(bgAsrCurrentBv, 'bt-green', '字幕已提取 ✓', false);
              bgFindTab(bgAsrCurrentBv, tab => {
                if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SUBTITLE_READY' }).catch(() => {});
              });
              bgBroadcast({ type: 'ASR_PROGRESS', bvId: bgAsrCurrentBv, done: true, charCount: d.char_count });
              streamDone = true; break;
            }
          } catch {}
        }
      }
    } catch {}

    bgAsrBusy = false;
    bgAsrCurrentBv = null;
    bgBroadcast({ type: 'ASR_STATE', busy: false, currentBv: null, queue: [...bgAsrQueue] });
  }
}

// 接收消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RECORD") {
    sendRecord(msg.data).then(result => {
      sendResponse(result);
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

  // ASR 入队：来自 sidebar 或悬浮窗按钮
  if (msg.type === "ENQUEUE_ASR" || msg.type === "TRIGGER_ASR") {
    if (msg.bvId) bgEnqueue(msg.bvId);
    sendResponse({});
    return true;
  }

  // 自动 ASR：来自 content.js 检测到无字幕
  if (msg.type === "AUTO_ASR") {
    if (!bgAutoAsr || !msg.bvId) { sendResponse({}); return true; }
    fetch(`${SERVER_URL}/api/video/${msg.bvId}`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(v => {
        if (v?.subtitle_in_db) {
          bgPushSubStatus(msg.bvId, 'bt-green', '字幕已提取 ✓', false);
          bgFindTab(msg.bvId, tab => {
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SUBTITLE_READY' }).catch(() => {});
          });
        } else {
          bgEnqueue(msg.bvId);
        }
      })
      .catch(() => bgEnqueue(msg.bvId));
    sendResponse({});
    return true;
  }

  // sidebar 请求当前 ASR 状态（打开时同步）
  if (msg.type === "GET_ASR_STATE") {
    sendResponse({ busy: bgAsrBusy, currentBv: bgAsrCurrentBv, queue: [...bgAsrQueue] });
    return true;
  }

  // settings 更新后通知 background 刷新
  if (msg.type === "SETTINGS_CHANGED") {
    bgRefreshSettings();
    return false;
  }
});

async function sendRecord(data) {
  const resp = await fetch(`${SERVER_URL}/api/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
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

// 启动时重发缓冲数据
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
