const API = 'http://localhost:9876';
let currentBvId = null;
let currentVideo = null;
let chatModel = 'deepseek-chat';
let chatSessionId = null;
let autoAsr = true;  // loaded from server settings

// ── Provider → models 映射 ──
const SIDEBAR_PROVIDERS = {
  deepseek:  [{id:'deepseek-chat',label:'V3.2'},{id:'deepseek-reasoner',label:'V3.2 思考'}],
  qwen:      [{id:'qwen-max',label:'Max'},{id:'qwen-plus',label:'Plus'},{id:'qwen-turbo',label:'Turbo'},{id:'qwen-long',label:'Long'}],
  doubao:    [{id:'doubao-1.5-pro-32k',label:'1.5 Pro 32k'},{id:'doubao-1.5-pro-256k',label:'1.5 Pro 256k'},{id:'doubao-1.5-lite-32k',label:'1.5 Lite 32k'}],
  moonshot:  [{id:'moonshot-v1-8k',label:'8k'},{id:'moonshot-v1-32k',label:'32k'},{id:'moonshot-v1-128k',label:'128k'}],
  zhipu:     [{id:'glm-4-plus',label:'GLM-4+'},{id:'glm-4-long',label:'GLM-4 Long'},{id:'glm-4-flash',label:'GLM-4 Flash'}],
  openai:    [{id:'gpt-4o',label:'4o'},{id:'gpt-4o-mini',label:'4o-mini'},{id:'gpt-4.1',label:'4.1'},{id:'o4-mini',label:'o4-mini'}],
  google:    [{id:'gemini-2.0-flash',label:'2.0F'},{id:'gemini-2.5-flash-preview-05-20',label:'2.5F'},{id:'gemini-2.5-pro-preview-06-05',label:'2.5P'}],
  anthropic: [{id:'claude-opus-4-5',label:'Opus'},{id:'claude-sonnet-4-5',label:'Sonnet'},{id:'claude-haiku-4-5-20251001',label:'Haiku'}],
  openrouter:[],
  custom:    []
};

function _updateModelSel(models, activeModel) {
  const sel = document.getElementById('model-sel');
  const txt = document.getElementById('custom-model-input');
  if (!sel) return;
  if (models.length > 0) {
    sel.innerHTML = '';
    models.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.value = activeModel;
    // 若 activeModel 不在列表中，选第一个
    if (sel.value !== activeModel) sel.value = models[0].id;
    txt.style.display = 'none'; txt.value = '';
    sel.style.display = '';
  } else {
    // openrouter / custom: 只显示文本框
    sel.style.display = 'none';
    txt.style.display = '';
    txt.value = activeModel || '';
  }
  chatModel = sel.style.display !== 'none' ? (sel.value || (models[0] ? models[0].id : '')) : (activeModel || '');
}

// model-sel change handler
document.getElementById('model-sel').addEventListener('change', function() {
  chatModel = this.value;
});

document.getElementById('custom-model-input').addEventListener('change', function() {
  const v = this.value.trim();
  if (v) chatModel = v;
});

let _settingsUpdatedAt = null;

async function loadSettings() {
  try {
    const r = await fetch(API + '/api/settings', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return;
    const s = await r.json();
    // updated_at 没变说明设置没改过，跳过（首次 _settingsUpdatedAt 为 null 必定执行）
    if (s.updated_at && s.updated_at === _settingsUpdatedAt) return;
    _settingsUpdatedAt = s.updated_at || '';
    autoAsr = s.auto_asr !== false;
    if (s.whisper_model) {
      const wm = document.getElementById('whisper-model');
      if (wm) wm.value = s.whisper_model;
    }
    const provider = s.default_provider || 'deepseek';
    const models = SIDEBAR_PROVIDERS[provider] || [];
    const pcfg = (s.providers || {})[provider] || {};
    const activeModel = pcfg.default_model || (models[0] ? models[0].id : 'deepseek-chat');
    const provLabel = document.getElementById('prov-label');
    if (provLabel) {
      const names = {deepseek:'DeepSeek',qwen:'通义千问',doubao:'豆包',moonshot:'Moonshot',zhipu:'智谱',openai:'OpenAI',google:'Google',anthropic:'Anthropic',openrouter:'OpenRouter',custom:'自定义'};
      provLabel.textContent = names[provider] || provider;
    }
    _updateModelSel(models, activeModel);
  } catch {}
}

// ── 面板按钮 ──
document.getElementById('btn-dashboard').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
});

// ── 字幕 badge 辅助 ──
function setSubBadge(state, text, showGenBtn, genBtnLabel) {
  const el = document.getElementById('vi-sub');
  el.className = 'vi-badge ' + state;
  el.textContent = text;
  const btn = document.getElementById('btn-gen-sub');
  btn.style.display = showGenBtn ? '' : 'none';
  if (showGenBtn) btn.textContent = genBtnLabel || '生成字幕';
}

function notifyContentSubtitleReady() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'SUBTITLE_READY' }).catch(() => {});
  });
}

function fmtChars(n) {
  if (!n) return '';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万字';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k字';
  return n + '字';
}

// 根据服务器返回的视频信息统一更新字幕状态
function _asrStatusText(bvId) {
  if (_bgAsr.currentBv === bvId) return '转写中...';
  return '排队中...';
}

function applySubtitleStatus(v) {
  if (v.subtitle_in_db) {
    const cnt = v.subtitle_char_count ? ' ' + fmtChars(v.subtitle_char_count) : '';
    setSubBadge('ok', '字幕 ✓' + cnt);
    notifyContentSubtitleReady();
  } else if (v.has_subtitle) {
    setSubBadge('warn', '自带字幕');
  } else {
    if (_maybeEnqueueASR(currentBvId, false)) {
      setSubBadge('warn', _asrStatusText(currentBvId));
    } else {
      setSubBadge('off', '无字幕', true);
    }
  }
}

// ── 生成字幕按钮 ──
document.getElementById('btn-gen-sub').addEventListener('click', () => {
  if (!currentBvId) return;
  chrome.runtime.sendMessage({ type: 'ENQUEUE_ASR', bvId: currentBvId });
  setSubBadge('warn', '排队中...');
  pbReset();
});

let _bgAsr = { busy: false, currentBv: null, queue: [] }; // background ASR 状态影子
let _bgSumm = { busy: false, currentBv: null, queue: [] }; // background 总结状态影子
let _summBubble = null;   // 正在流式输出的总结气泡 div
let _summMainDiv = null;  // 气泡内容 div
let _summAsrRan = false;  // 本次总结是否触发了内置 ASR
let _summHasText = false; // 是否已开始写 delta 文字

function _maybeEnqueueASR(bvId, hasSubtitleAlready) {
  if (hasSubtitleAlready || !autoAsr || !bvId) return false;
  return _bgAsr.currentBv === bvId || _bgAsr.queue.includes(bvId);
}

// ── 触发字幕状态查询，结果通过 SUB_STATUS 广播返回 ──
function syncSubtitleStatus(bvId) {
  chrome.runtime.sendMessage({ type: 'GET_SUB_STATUS', bvId }).catch(() => {});
}

// ── 视频信息 ──
// tabs 由调用方传入，避免重复查询
async function loadVideoInfo() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0] || null;
  } catch {}

  if (tab?.id) {
    const response = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000);
      chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_INFO' }, resp => {
        clearTimeout(timer);
        resolve(chrome.runtime.lastError ? null : (resp || null));
      });
    });

    if (response?.bvId) {
      currentBvId = response.bvId;
      currentVideo = response.videoData;
      document.getElementById('vi-title').textContent = currentVideo.title || currentBvId;
      document.getElementById('vi-meta').textContent =
        `${currentVideo.up_name || ''} · ${currentVideo.duration ? Math.floor(currentVideo.duration/60)+'分钟' : ''}`;
      document.getElementById('vi-server').className = 'vi-badge ' + (response.serverConnected ? 'ok' : 'off');
      document.getElementById('vi-server').textContent = response.serverConnected ? 'Server ✓' : 'Server ✗';
      syncSubtitleStatus(currentBvId);
    } else {
      await fallbackFromTab(tab);
    }
  } else {
    await fallbackFromTab(null);
  }

  loadBalance();
  loadHistoryBar();
}

// content.js 无响应时从 tab URL/title 降级，使用已有的 tab 对象不重复查询
async function fallbackFromTab(tab) {
  const match = tab?.url?.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  if (!match) {
    document.getElementById('vi-title').textContent = '未检测到B站视频';
    document.getElementById('vi-meta').textContent = '请打开一个B站视频页面';
    return;
  }
  currentBvId = match[1];
  document.getElementById('vi-title').textContent =
    tab.title?.replace(/_哔哩哔哩_bilibili/, '').trim() || currentBvId;
  document.getElementById('vi-meta').textContent = currentBvId;
  try {
    const r = await fetch(API + '/api/video/' + currentBvId, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const v = await r.json();
      document.getElementById('vi-title').textContent = v.title || currentBvId;
      document.getElementById('vi-meta').textContent =
        `${v.up_name || ''} · ${v.duration ? Math.floor(v.duration/60)+'分钟' : ''}`;
      document.getElementById('vi-server').className = 'vi-badge ok';
      document.getElementById('vi-server').textContent = 'Server ✓';
      applySubtitleStatus(v);
      return;
    }
  } catch {}
  if (_maybeEnqueueASR(currentBvId, false)) {
    setSubBadge('warn', _asrStatusText(currentBvId));
  } else {
    setSubBadge('off', '无字幕', true);
  }
}

function updateAsrBar() {
  const bar = document.getElementById('asr-queue-bar');
  const txt = document.getElementById('asr-queue-text');
  if (!_bgAsr.busy && _bgAsr.queue.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const parts = [];
  if (_bgAsr.busy && _bgAsr.currentBv) {
    parts.push(_bgAsr.currentBv === currentBvId ? '转写中（当前视频）' : `转写中: ${_bgAsr.currentBv}`);
  }
  if (_bgAsr.queue.length > 0) parts.push(`队列: ${_bgAsr.queue.length} 个`);
  txt.textContent = parts.join(' · ');
}

// processASRQueue 已迁移到 background.js，sidebar 通过 ASR_PROGRESS 消息更新 UI

function updateSummBar() {
  const bar = document.getElementById('summ-queue-bar');
  const txt = document.getElementById('summ-queue-text');
  if (!_bgSumm.busy && _bgSumm.queue.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const parts = [];
  if (_bgSumm.busy && _bgSumm.currentBv) {
    parts.push(_bgSumm.currentBv === currentBvId ? '总结中（当前视频）' : `总结中: ${_bgSumm.currentBv}`);
  }
  if (_bgSumm.queue.length > 0) parts.push(`待总结: ${_bgSumm.queue.length} 个`);
  txt.textContent = parts.join(' · ');
}

// ── 总结进度处理（来自 background SUMM_PROGRESS 广播）──
function handleSummProgress(msg) {
  if (msg.bvId !== currentBvId) return;
  const summBtn = document.getElementById('summ-btn');
  const sendBtn = document.getElementById('c-send');
  const input = document.getElementById('c-input');
  const msgs = document.getElementById('c-msgs');

  // 气泡不存在时（sidebar 晚于总结开始打开）按需创建
  if (!_summBubble) {
    _summBubble = document.createElement('div');
    _summBubble.className = 'msg b summ-msg streaming';
    const label = document.createElement('div');
    label.className = 'msg-label'; label.textContent = '视频总结';
    _summMainDiv = document.createElement('div');
    _summMainDiv.style.color = '#9a7858'; _summMainDiv.textContent = '总结中...';
    _summBubble.appendChild(label); _summBubble.appendChild(_summMainDiv);
    msgs.appendChild(_summBubble);
    lockUI(summBtn, sendBtn, input, 'summ');
  }

  if (msg.error) {
    pbDone();
    _summMainDiv.style.color = '#f55050'; _summMainDiv.textContent = '错误: ' + msg.error;
    // 不强制设"无字幕"：若 SUMM 内部 ASR 已成功，字幕已入库，background bgQueryAndPush 会推正确状态
    _summBubble.classList.remove('streaming');
    unlockUI(summBtn, sendBtn, input);
    _summBubble = null; _summMainDiv = null; _summAsrRan = false; _summHasText = false;
    return;
  }
  if (msg.progress) {
    _summMainDiv.style.color = '#9a7858'; _summMainDiv.textContent = msg.progress;
    pbShow(msg.progress);
    if (msg.asrActive) { setSubBadge('warn', '转写中...'); _summAsrRan = true; }
  }
  if (msg.delta) {
    if (!_summHasText) {
      _summMainDiv.textContent = ''; _summMainDiv.style.color = '';
      _summHasText = true;
      if (_summAsrRan) setSubBadge('ok', '字幕 ✓');
    }
    _summMainDiv.textContent += msg.delta;
    msgs.scrollTop = msgs.scrollHeight;
  }
  if (msg.done) {
    pbDone();
    loadBalance();
    notifyContentSubtitleReady();
    if (_summAsrRan) { chatSessionId = null; syncSubtitleStatus(currentBvId); }
    summBtn.textContent = '重新总结';
    renderSummary(msg.fullText, _summMainDiv);
    _summBubble.classList.remove('streaming');
    _summBubble._data = { type: 'summary', raw: msg.fullText };
    msgs.scrollTop = msgs.scrollHeight;
    unlockUI(summBtn, sendBtn, input);
    _summBubble = null; _summMainDiv = null; _summAsrRan = false; _summHasText = false;
  }
}

// ── 历史对话 ──
let _historySessions = [];
let _historyLoadedBv = null;  // 用户点击加载历史后置为 currentBvId，防止切回同一视频时重复显示历史条

async function loadHistoryBar() {
  const bar = document.getElementById('history-bar');
  if (!currentBvId || _historyLoadedBv === currentBvId) { bar.style.display = 'none'; return; }
  try {
    const r = await fetch(`${API}/api/chat/sessions?bv_id=${currentBvId}&limit=20`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) { bar.style.display = 'none'; return; }
    const d = await r.json();
    _historySessions = (d.sessions || []).filter(s => s.msg_count > 0);
    if (_historySessions.length === 0) { bar.style.display = 'none'; return; }
    const totalMsgs = _historySessions.reduce((s, x) => s + x.msg_count, 0);
    document.getElementById('history-label').textContent = `该视频有 ${totalMsgs} 条历史消息`;
    bar.style.display = 'flex';
  } catch { bar.style.display = 'none'; }
}

document.getElementById('history-load-btn').addEventListener('click', async () => {
  if (!_historySessions.length) return;
  const msgs = document.getElementById('c-msgs');
  const bvIdAtLoad = currentBvId; // 守护：异步加载期间用户切走则终止
  // 按时间顺序渲染所有 session 的消息
  for (const session of [..._historySessions].reverse()) {
    if (currentBvId !== bvIdAtLoad) break; // 用户已切换视频，停止追加
    try {
      const r = await fetch(`${API}/api/chat/session/${session.id}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const d = await r.json();
      if (currentBvId !== bvIdAtLoad) break; // fetch 期间切走
      for (const m of d.messages) {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.role === 'user' ? 'u' : 'b');
        msgs.appendChild(div);
        if (m.role === 'assistant') {
          div._data = { type: 'bot', text: m.content };
          renderSummary(m.content, div);
        } else {
          div._data = { type: 'user', text: m.content };
          div.textContent = m.content;
        }
      }
    } catch {}
  }
  // 继续最近一条 session
  chatSessionId = _historySessions[0].id;
  msgs.scrollTop = msgs.scrollHeight;
  _historyLoadedBv = currentBvId;
  document.getElementById('history-bar').style.display = 'none';
});

function loadBalance() {
  chrome.runtime.sendMessage({ type: 'GET_BALANCE' }, resp => {
    if (chrome.runtime.lastError || !resp?.cache) return;
    const d = resp.cache;
    const el = document.getElementById('vi-balance');
    if (!el || d.total_balance == null) return;
    el.textContent = '¥' + d.total_balance;
    el.style.color = parseFloat(d.total_balance) < 1 ? '#f55050' : '#888';
  });
}

// 版本检查只在 sidebar 启动时运行一次，不随视频切换重复请求
async function checkVersionOnce() {
  if (document.getElementById('vi-update-warn')) return;
  try {
    const r = await fetch(API + '/api/health', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.version) return;
    const extVer = chrome.runtime.getManifest().version;
    if (d.version === extVer) return;
    const el = document.createElement('div');
    el.id = 'vi-update-warn';
    el.style.cssText = 'padding:6px 14px;background:#3a2a10;color:#f5c542;font-size:10px;border-bottom:1px solid #3a3a1a;cursor:pointer';
    el.textContent = '⚠ 版本不一致，请到 chrome://extensions 点刷新';
    el.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions' }));
    document.querySelector('.video-info')?.after(el);
  } catch {}
}

// ── 进度条 ──
let _pbTimer = null, _pbVal = 0;
function _pbSpeed(text) {
  if (text.includes('下载音频')) return 150000;
  if (text.includes('Whisper') || text.includes('转写')) return 40000;
  if (text.includes('总结')) return 20000;
  return 8000;
}
function pbShow(text) {
  const area = document.getElementById('pb-area');
  area.style.display = 'block';
  document.getElementById('pb-label').textContent = text;
  if (_pbTimer) clearInterval(_pbTimer);
  const k = 1 - Math.exp(-300 / (_pbSpeed(text) / 3));
  _pbTimer = setInterval(() => {
    _pbVal += (90 - _pbVal) * k;
    document.getElementById('pb-fill').style.width = _pbVal.toFixed(1) + '%';
  }, 300);
}
function pbDone() {
  if (_pbTimer) { clearInterval(_pbTimer); _pbTimer = null; }
  document.getElementById('pb-fill').style.width = '100%';
  setTimeout(() => {
    document.getElementById('pb-area').style.display = 'none';
    document.getElementById('pb-fill').style.width = '0%';
    _pbVal = 0;
  }, 500);
}
function pbReset() {
  if (_pbTimer) { clearInterval(_pbTimer); _pbTimer = null; }
  _pbVal = 0;
  document.getElementById('pb-area').style.display = 'none';
  document.getElementById('pb-fill').style.width = '0%';
}

// ── UI 锁定 / 解锁 ──
// mode='summ': 总结按钮显示"生成中…"，发送按钮淡出
// mode='chat': 总结按钮淡出，发送按钮显示"发送中…"
function lockUI(summBtn, sendBtn, input, mode) {
  input.disabled = true;
  if (mode === 'chat') {
    summBtn.disabled = true; summBtn.classList.add('btn-faded');
    sendBtn.disabled = true; sendBtn.textContent = '发送中…'; sendBtn.classList.add('btn-working');
  } else {
    summBtn.disabled = true; summBtn.textContent = '生成中…'; summBtn.classList.add('btn-working');
    sendBtn.disabled = true; sendBtn.classList.add('btn-faded');
  }
}
function unlockUI(summBtn, sendBtn, input) {
  summBtn.disabled = false;
  summBtn.classList.remove('btn-working', 'btn-faded');
  sendBtn.disabled = false; sendBtn.textContent = '发送';
  sendBtn.classList.remove('btn-working', 'btn-faded');
  input.disabled = false; input.focus();
}

// ── session ──
async function ensureSession() {
  if (chatSessionId) return;
  const r = await fetch(API + '/api/chat/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      bv_id: currentBvId,
      model: chatModel,
      include_stats: document.getElementById('c-stats').checked
    })
  });
  const d = await r.json();
  chatSessionId = d.session_id;
}

// ── 结构化总结渲染 ──
function renderSummaryJson(data, container) {
  container.innerHTML = '';
  function sec(title, content) {
    const wrap = document.createElement('div'); wrap.className = 'summ-section';
    const t = document.createElement('div'); t.className = 'summ-sec-title'; t.textContent = title;
    wrap.appendChild(t); wrap.appendChild(content); container.appendChild(wrap);
  }
  if (data.概述) {
    const b = document.createElement('div'); b.className = 'summ-sec-body'; b.textContent = data.概述;
    sec('概述', b);
  }
  if (data.详述) {
    const wrap = document.createElement('div'); wrap.className = 'summ-sec-body';
    data.详述.split(/\n+/).filter(p => p.trim()).forEach(p => {
      const para = document.createElement('p'); para.textContent = p.trim();
      para.style.marginBottom = '6px';
      wrap.appendChild(para);
    });
    sec('详述', wrap);
  }
  if (data.结论?.length) {
    const ul = document.createElement('ul'); ul.className = 'summ-list';
    data.结论.forEach(c => { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); });
    sec('结论', ul);
  }
  if (data.干货?.length) {
    const wrap = document.createElement('div'); wrap.className = 'summ-ganghuo';
    data.干货.forEach(g => {
      const item = document.createElement('div'); item.className = 'summ-gh-item';
      const type = document.createElement('span'); type.className = 'summ-gh-type';
      type.textContent = (typeof g === 'object' ? g.类型 : '') || '信息';
      const text = document.createElement('span'); text.className = 'summ-gh-text';
      text.textContent = typeof g === 'object' ? g.内容 : g;
      item.appendChild(type); item.appendChild(text); wrap.appendChild(item);
    });
    sec('干货', wrap);
  }
  if (data.建议?.length) {
    const ul = document.createElement('ul'); ul.className = 'summ-list';
    data.建议.forEach(b => { const li = document.createElement('li'); li.textContent = b; ul.appendChild(li); });
    sec('建议', ul);
  }
  if (data.标签?.length) {
    const wrap = document.createElement('div'); wrap.className = 'summ-tags';
    data.标签.forEach(t => {
      const tag = document.createElement('span'); tag.className = 'summ-tag'; tag.textContent = t;
      wrap.appendChild(tag);
    });
    sec('标签', wrap);
  }
}

function renderSummary(text, container) {
  try {
    // 尝试提取 JSON（模型可能在 JSON 前后有少量文字）
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      if (data.概述 || data.干货) { renderSummaryJson(data, container); return; }
    }
  } catch {}
  // 旧纯文本总结降级显示
  container.style.whiteSpace = 'pre-wrap';
  container.textContent = text;
}

// ── 生成总结：入队交给 background，UI 由 SUMM_PROGRESS 广播驱动 ──
document.getElementById('summ-btn').addEventListener('click', () => {
  if (!currentBvId) return;
  const bvId = currentBvId;
  const summBtn = document.getElementById('summ-btn');
  const sendBtn = document.getElementById('c-send');
  const input = document.getElementById('c-input');
  const msgs = document.getElementById('c-msgs');

  if (_bgSumm.currentBv === bvId || _bgSumm.queue.includes(bvId)) return; // 已在队列

  const force = summBtn.textContent === '重新总结';
  lockUI(summBtn, sendBtn, input, 'summ');
  pbReset();
  document.getElementById('btn-gen-sub').style.display = 'none';

  // 先创建占位气泡，等 SUMM_PROGRESS 到了再填内容
  _summBubble = document.createElement('div');
  _summBubble.className = 'msg b summ-msg streaming';
  const label = document.createElement('div');
  label.className = 'msg-label'; label.textContent = '视频总结';
  _summMainDiv = document.createElement('div');
  _summMainDiv.style.color = '#9a7858';
  _summMainDiv.textContent = _bgSumm.busy ? '等待队列...' : '准备中...';
  _summBubble.appendChild(label); _summBubble.appendChild(_summMainDiv);
  msgs.appendChild(_summBubble); msgs.scrollTop = msgs.scrollHeight;

  chrome.runtime.sendMessage({
    type: 'ENQUEUE_SUMM', bvId,
    model: chatModel,
    whisperModel: document.getElementById('whisper-model').value,
    force
  });
});

// ── 对话发送 ──
let lastChatText = '';

async function sendChat(retryText) {
  const input = document.getElementById('c-input');
  const sendBtn = document.getElementById('c-send');
  const summBtn = document.getElementById('summ-btn');
  const text = retryText || input.value.trim();
  if (!text) return;
  if (!retryText) input.value = '';
  lastChatText = text;

  await ensureSession();

  const msgs = document.getElementById('c-msgs');
  if (!retryText) {
    const uDiv = Object.assign(document.createElement('div'), { className: 'msg u', textContent: text });
    uDiv._data = { type: 'user', text };
    msgs.appendChild(uDiv);
  }

  lockUI(summBtn, sendBtn, input, 'chat');

  const ldDiv = Object.assign(document.createElement('div'), { className: 'msg b ld', id: 'ld', textContent: '思考中...' });
  msgs.appendChild(ldDiv); msgs.scrollTop = msgs.scrollHeight;

  let bubble = null;
  try {
    const r = await fetch(API + '/api/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: chatSessionId,
        message: text,
        web_search: document.getElementById('c-websearch').checked
      })
    });
    document.getElementById('ld')?.remove();
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      appendError(msgs, e.detail || `请求失败 (${r.status})`);
      return;
    }

    bubble = document.createElement('div'); bubble.className = 'msg b streaming';
    const mainDiv = document.createElement('div');
    bubble.appendChild(mainDiv);
    msgs.appendChild(bubble);

    let thinkWrap=null, thinkBody=null, thinkLabel=null, thinkArrow=null;
    let thinkStart=null, thinkTimer=null;

    function initThinking() {
      thinkStart = Date.now();
      thinkWrap = document.createElement('div'); thinkWrap.className = 'thinking-wrap';
      const thinkHdr = document.createElement('div'); thinkHdr.className = 'thinking-hdr';
      thinkLabel = document.createElement('span'); thinkLabel.textContent = '思考中...';
      thinkArrow = document.createElement('span'); thinkArrow.textContent = ' ▼';
      thinkHdr.appendChild(thinkLabel); thinkHdr.appendChild(thinkArrow);
      thinkBody = document.createElement('div'); thinkBody.className = 'thinking-body';
      thinkWrap.appendChild(thinkHdr); thinkWrap.appendChild(thinkBody);
      bubble.insertBefore(thinkWrap, mainDiv);
      thinkHdr.addEventListener('click', () => {
        thinkBody.classList.toggle('hidden');
        thinkArrow.textContent = thinkBody.classList.contains('hidden') ? ' ▶' : ' ▼';
      });
      thinkTimer = setInterval(() => {
        thinkLabel.textContent = `思考中 ${((Date.now()-thinkStart)/1000).toFixed(1)}s`;
      }, 200);
    }
    function finishThinking() {
      if (!thinkTimer) return;
      clearInterval(thinkTimer); thinkTimer = null;
      thinkLabel.textContent = `思考完成 (${((Date.now()-thinkStart)/1000).toFixed(1)}s)`;
      thinkBody.classList.add('hidden'); thinkArrow.textContent = ' ▶';
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
          if (d.error) { appendError(msgs, d.error); break; }
          if (d.reasoning) {
            if (!thinkWrap) initThinking();
            thinkBody.textContent += d.reasoning;
            thinkBody.scrollTop = thinkBody.scrollHeight;
          }
          if (d.delta) {
            finishThinking();
            mainDiv.textContent += d.delta;
            msgs.scrollTop = msgs.scrollHeight;
          }
          if (d.done) {
            bubble.classList.remove('streaming'); loadBalance();
            bubble._data = { type: 'bot', text: mainDiv.textContent };
          }
        } catch {}
      }
    }
    finishThinking();
  } catch (e) {
    document.getElementById('ld')?.remove();
    appendError(msgs, e.message.includes('fetch') ? 'Server 未连接' : e.message);
  } finally {
    bubble?.classList.remove('streaming');
    unlockUI(summBtn, sendBtn, input);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function appendError(msgs, errText) {
  const div = document.createElement('div');
  div.className = 'msg b';
  div.style.color = '#f55050';
  div.innerHTML = `${esc(errText)} <span class="retry-btn">↩ 重试</span>`;
  div.querySelector('.retry-btn').addEventListener('click', () => { div.remove(); sendChat(lastChatText); });
  msgs.appendChild(div);
}

document.getElementById('c-send').addEventListener('click', () => sendChat());
document.getElementById('c-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

// ── 每视频对话状态缓存（LRU，最多保留10个视频）──
const videoStates = {};
const _videoStatesOrder = [];
const MAX_VIDEO_STATES = 10;

function saveVideoState(bvId) {
  if (!bvId) return;
  const msgs = document.getElementById('c-msgs');
  const messages = [];
  msgs.querySelectorAll('.msg').forEach(el => {
    if (el._data) messages.push(el._data);
  });
  videoStates[bvId] = { sessionId: chatSessionId, messages };

  // 维护 LRU 顺序
  const idx = _videoStatesOrder.indexOf(bvId);
  if (idx > -1) _videoStatesOrder.splice(idx, 1);
  _videoStatesOrder.unshift(bvId);
  if (_videoStatesOrder.length > MAX_VIDEO_STATES) {
    const oldest = _videoStatesOrder.pop();
    delete videoStates[oldest];
  }
}

function restoreVideoState(bvId) {
  const msgs = document.getElementById('c-msgs');
  msgs.innerHTML = '';
  chatSessionId = null;
  // 无论上一个视频是否有进行中的操作，切换时必须重置所有 UI 锁
  // 否则 lockUI 留下的 disabled + btn-working 会卡在新视频上
  const summBtn = document.getElementById('summ-btn');
  const sendBtn = document.getElementById('c-send');
  const input = document.getElementById('c-input');
  unlockUI(summBtn, sendBtn, input);
  summBtn.textContent = '总结';
  // 切换视频时丢弃旧总结气泡引用（旧气泡所在的 msgs 已被清空）
  _summBubble = null; _summMainDiv = null; _summAsrRan = false; _summHasText = false;
  const st = videoStates[bvId];
  if (!st?.messages?.length) return;
  chatSessionId = st.sessionId;
  st.messages.forEach(m => {
    if (m.type === 'user') {
      const div = Object.assign(document.createElement('div'), { className: 'msg u', textContent: m.text });
      div._data = m; msgs.appendChild(div);
    } else if (m.type === 'summary') {
      const bubble = document.createElement('div'); bubble.className = 'msg b summ-msg';
      const label = document.createElement('div'); label.className = 'msg-label'; label.textContent = '视频总结';
      const mainDiv = document.createElement('div');
      bubble.appendChild(label); bubble.appendChild(mainDiv);
      renderSummary(m.raw, mainDiv);
      bubble._data = m; msgs.appendChild(bubble);
    } else {
      const div = document.createElement('div'); div.className = 'msg b';
      div._data = m; msgs.appendChild(div);
      renderSummary(m.text, div);
    }
  });
  msgs.scrollTop = msgs.scrollHeight;
  if (st.messages.some(m => m.type === 'summary'))
    document.getElementById('summ-btn').textContent = '重新总结';
}

// ── 视频切换检测 + 设置同步（事件驱动，无轮询）──
let lastBv = null;
let _updating = false;
let _pendingUpdate = false;

async function onVideoChanged() {
  setSubBadge('off', '检测中…', false);
  if (_updating) { _pendingUpdate = true; return; }
  _updating = true;
  _pendingUpdate = false;
  try {
    const prevBvId = currentBvId;
    await Promise.all([loadVideoInfo(), loadSettings()]);
    // 兜底：visibilitychange / 初次加载等无 VIDEO_CHANGED 的路径，仍在此做 save/restore
    if (currentBvId && currentBvId !== lastBv) {
      saveVideoState(prevBvId);
      lastBv = currentBvId;
      _historyLoadedBv = null;
      restoreVideoState(currentBvId);
    }
  } catch {} finally {
    _updating = false;
    if (_pendingUpdate) setTimeout(onVideoChanged, 0);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "VIDEO_CHANGED") {
    // bvId 跟着切换即时更新：SUB_STATUS 过滤直接用 currentBvId，不需要 _pendingBvId
    if (msg.bvId && msg.bvId !== currentBvId) {
      saveVideoState(currentBvId);
      currentBvId = msg.bvId;
      lastBv = msg.bvId;       // 让 onVideoChanged 跳过重复 save/restore
      _historyLoadedBv = null;
      restoreVideoState(msg.bvId);
    }
    onVideoChanged();
  }

  // background.js 广播字幕状态（background 已算好，直接渲染）
  if (msg.type === "SUB_STATUS") {
    if (msg.bvId !== currentBvId) return; // currentBvId 已即时更新，直接过滤即可
    const state = msg.cls === 'bt-green' ? 'ok' : (msg.cls === 'bt-yellow' || msg.cls === 'bt-asr') ? 'warn' : 'off';
    const charCount = (msg.cls === 'bt-green' && msg.videoInfo?.subtitle_char_count)
      ? ' ' + fmtChars(msg.videoInfo.subtitle_char_count) : '';
    setSubBadge(state, msg.title + charCount, msg.showGenBtn);
    if (msg.videoInfo?.subtitle_in_db) notifyContentSubtitleReady();
  }

  // background.js 广播总结队列状态变化
  if (msg.type === "SUMM_STATE") {
    _bgSumm = { busy: msg.busy, currentBv: msg.currentBv, queue: msg.queue };
    updateSummBar();
    // 当前视频不再被总结且气泡还挂着 → 说明 SW 重启等意外，清理
    if (_summBubble && msg.currentBv !== currentBvId && !msg.queue.includes(currentBvId)) {
      _summBubble.classList.remove('streaming');
      _summBubble = null; _summMainDiv = null; _summAsrRan = false; _summHasText = false;
      const summBtn = document.getElementById('summ-btn');
      const sendBtn = document.getElementById('c-send');
      const input = document.getElementById('c-input');
      if (summBtn) unlockUI(summBtn, sendBtn, input);
    }
  }

  // background.js 广播总结进度
  if (msg.type === "SUMM_PROGRESS") handleSummProgress(msg);

  // background.js 广播 ASR 队列状态变化
  if (msg.type === "ASR_STATE") {
    _bgAsr = { busy: msg.busy, currentBv: msg.currentBv, queue: msg.queue };
    updateAsrBar();
  }

  // background.js 广播 ASR 进度（只处理当前视频）
  if (msg.type === "ASR_PROGRESS") {
    if (msg.bvId === currentBvId) {
      if (msg.error)    { pbDone(); setSubBadge('off', '无字幕', true); }
      if (msg.progress) { pbShow(msg.progress); setSubBadge('warn', '转写中...'); }
      if (msg.done) {
        pbDone();
        chatSessionId = null;
        syncSubtitleStatus(currentBvId);
      }
    }
  }
});

// sidebar 从后台切回时刷新（tab/窗口切换由 background 广播 VIDEO_CHANGED）
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onVideoChanged();
});

// 设置偶尔变更，每30秒同步一次（轻量）
setInterval(loadSettings, 30000);

// 先同步 background 状态 + 加载设置，全部就绪后再初始化视频信息
// 保证 _bgAsr/_bgSumm 在 _maybeEnqueueASR 执行前已填充
Promise.all([
  new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_ASR_STATE' }, (resp) => {
    if (resp) { _bgAsr = resp; updateAsrBar(); }
    resolve();
  })),
  new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_SUMM_STATE' }, (resp) => {
    if (resp) {
      _bgSumm = { busy: resp.busy, currentBv: resp.currentBv, queue: resp.queue };
      updateSummBar();
      // SW 重启后内存清空：若气泡还挂着但 background 已无任务，解锁 UI
      if (_summBubble && !resp.busy && !resp.queue.includes(currentBvId)) {
        _summBubble.classList.remove('streaming');
        _summBubble = null; _summMainDiv = null; _summAsrRan = false; _summHasText = false;
        const summBtn = document.getElementById('summ-btn');
        const sendBtn = document.getElementById('c-send');
        const input = document.getElementById('c-input');
        if (summBtn && sendBtn && input) unlockUI(summBtn, sendBtn, input);
      }
    }
    resolve();
  })),
  loadSettings(),
]).finally(() => onVideoChanged());
checkVersionOnce();
