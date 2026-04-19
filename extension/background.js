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

// 接收content script消息
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
    // content.js 和 sidebar.js 都用这个消息获取余额
    sendResponse({ cache: balanceCache.data, error: balanceCache.error, ts: balanceCache.ts });
    return false;
  }

  if (msg.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: SERVER_URL });
    return false;
  }

  if (msg.type === "FORCE_UPLOAD") {
    // 通知content.js立即上报数据
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
