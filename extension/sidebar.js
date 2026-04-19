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

function fmtChars(n) {
  if (!n) return '';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万字';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k字';
  return n + '字';
}

// 根据服务器返回的视频信息统一更新字幕状态
// ASR 状态文字：三态分开，避免"排队中"掩盖"检测中"
function _asrStatusText(bvId) {
  if (asrBusy && asrCurrentBv === bvId) return '转写中...';
  if (_asrTimers.has(bvId)) return '检测字幕...';
  return '排队中...';
}

function applySubtitleStatus(v) {
  if (v.subtitle_in_db) {
    const cnt = v.subtitle_char_count ? ' ' + fmtChars(v.subtitle_char_count) : '';
    setSubBadge('ok', '字幕 ✓' + cnt);
    _maybeEnqueueASR(currentBvId, true); // 取消可能的待定计时器
    notifyContentSubtitleReady();
  } else if (v.has_subtitle) {
    // B站自带 CC 字幕存在（待提取），取消 ASR
    _maybeEnqueueASR(currentBvId, true);
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
document.getElementById('btn-gen-sub').addEventListener('click', async () => {
  if (!currentBvId) return;
  const btn = document.getElementById('btn-gen-sub');
  btn.disabled = true;
  setSubBadge('warn', '准备中...');
  pbReset();

  try {
    const r = await fetch(API + '/api/extract_subtitle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bv_id: currentBvId,
        whisper_model: document.getElementById('whisper-model').value
      })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setSubBadge('off', '失败', true);
      appendSubError(e.detail || '字幕生成失败');
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
          if (d.error) {
            pbDone();
            setSubBadge('off', '失败', true);
            appendSubError(d.error);
            return;
          }
          if (d.progress) {
            pbShow(d.progress);
            setSubBadge('warn', '转写中...');
          }
          if (d.done) {
            pbDone();
            const cnt = d.char_count ? ' ' + fmtChars(d.char_count) : '';
            setSubBadge('ok', '字幕 ✓' + cnt);
            chatSessionId = null;
            notifyContentSubtitleReady();
          }
        } catch {}
      }
    }
  } catch (e) {
    pbDone();
    setSubBadge('off', '失败', true);
    appendSubError(e.message.includes('fetch') ? 'Server 未连接' : e.message);
  } finally {
    btn.disabled = false;
  }
});

function appendSubError(msg) {
  const msgs = document.getElementById('c-msgs');
  const div = document.createElement('div');
  div.className = 'msg b';
  div.style.color = '#f55050';
  div.textContent = '字幕生成失败: ' + msg;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// 已确认入队/转写中的 bvId（不再重复入队）
const _asrEnqueued = new Set();
// 待确认计时器：等待字幕检测稳定后再决定是否转写（bvId → setTimeout id）
const _asrTimers = new Map();

// 统一处理 autoAsr 入队逻辑，延迟 5s 确认无字幕后才真正入队
function _maybeEnqueueASR(bvId, hasSubtitleAlready) {
  if (hasSubtitleAlready) {
    // 有字幕 → 取消待定计时器
    if (_asrTimers.has(bvId)) {
      clearTimeout(_asrTimers.get(bvId));
      _asrTimers.delete(bvId);
    }
    return false;
  }
  if (!autoAsr || !bvId) return false;
  if (_asrEnqueued.has(bvId)) return true;  // 已在队列/转写中
  if (_asrTimers.has(bvId)) return true;    // 已在等待期
  // 延迟 5s：等 content.js 初始化、B站字幕检测完成后再确认
  const tid = setTimeout(() => {
    _asrTimers.delete(bvId);
    _asrEnqueued.add(bvId);
    enqueueASR(bvId);
  }, 5000);
  _asrTimers.set(bvId, tid);
  return true;
}

// ── 视频信息 ──
async function loadVideoInfo() {
  try {
    const response = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'GET_CURRENT_VIDEO' }, resolve));
    if (response && response.bvId) {
      currentBvId = response.bvId;
      currentVideo = response.videoData;
      document.getElementById('vi-title').textContent = currentVideo.title || currentBvId;
      document.getElementById('vi-meta').textContent =
        `${currentVideo.up_name || ''} · ${currentVideo.duration ? Math.floor(currentVideo.duration/60)+'分钟' : ''}`;
      document.getElementById('vi-server').className = 'vi-badge ' + (response.serverConnected ? 'ok' : 'off');
      document.getElementById('vi-server').textContent = response.serverConnected ? 'Server ✓' : 'Server ✗';
      // 统一查DB拿字幕状态和字数
      try {
        const r = await fetch(API + '/api/video/' + currentBvId);
        if (r.ok) {
          applySubtitleStatus(await r.json());
        } else {
          // 视频未入库（新视频）—— 依然尝试 autoAsr
          const hasSub = response.subtitleExtracted || response.hasSubtitle;
          if (_maybeEnqueueASR(currentBvId, hasSub)) {
            setSubBadge('warn', _asrStatusText(currentBvId));
          } else {
            setSubBadge(hasSub ? 'ok' : 'off', hasSub ? '字幕 ✓' : '无字幕', !hasSub);
          }
        }
      } catch {
        const hasSub = response.subtitleExtracted || response.hasSubtitle;
        if (_maybeEnqueueASR(currentBvId, hasSub)) {
          setSubBadge('warn', _asrStatusText(currentBvId));
        } else {
          setSubBadge(hasSub ? 'ok' : 'off', hasSub ? '字幕 ✓' : '无字幕', !hasSub);
        }
      }
    } else {
      await fallbackFromTabUrl();
    }
  } catch { await fallbackFromTabUrl(); }
  loadBalance();
  loadHistoryBar();
}

async function fallbackFromTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const match = tabs[0].url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
      if (match) {
        currentBvId = match[1];
        document.getElementById('vi-title').textContent = tabs[0].title?.replace(/_哔哩哔哩_bilibili/, '').trim() || currentBvId;
        document.getElementById('vi-meta').textContent = currentBvId;
        try {
          const r = await fetch(API + '/api/video/' + currentBvId);
          if (r.ok) {
            const v = await r.json();
            document.getElementById('vi-title').textContent = v.title || currentBvId;
            document.getElementById('vi-meta').textContent = `${v.up_name || ''} · ${v.duration ? Math.floor(v.duration/60)+'分钟' : ''}`;
            document.getElementById('vi-server').className = 'vi-badge ok';
            document.getElementById('vi-server').textContent = 'Server ✓';
            applySubtitleStatus(v);
          } else {
            // 视频未入库，也尝试 autoAsr
            if (_maybeEnqueueASR(currentBvId, false)) {
              setSubBadge('warn', _asrStatusText(currentBvId));
            } else {
              setSubBadge('off', '无字幕', true);
            }
          }
        } catch {}
        return;
      }
    }
    document.getElementById('vi-title').textContent = '未检测到B站视频';
    document.getElementById('vi-meta').textContent = '请打开一个B站视频页面';
  } catch {
    document.getElementById('vi-title').textContent = '未检测到B站视频';
  }
}

// ── ASR 自动转写队列 ──
const asrQueue = [];       // 等待转写的 bvId 列表
let asrBusy = false;       // 是否正在转写
let asrCurrentBv = null;   // 当前转写的 bvId

function enqueueASR(bvId) {
  if (asrCurrentBv === bvId) return;          // 正在转写此视频
  const idx = asrQueue.indexOf(bvId);
  if (idx > -1) asrQueue.splice(idx, 1);      // 已在队列中则先移除
  asrQueue.unshift(bvId);                     // 插到队首（最高优先级）
  if (asrQueue.length > 50) asrQueue.length = 50;
  updateAsrBar();
  processASRQueue();
}

function updateAsrBar() {
  const bar = document.getElementById('asr-queue-bar');
  const txt = document.getElementById('asr-queue-text');
  if (!asrBusy && asrQueue.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const parts = [];
  if (asrBusy && asrCurrentBv) {
    const isCurrent = asrCurrentBv === currentBvId;
    parts.push(isCurrent ? '转写中（当前视频）' : `转写中: ${asrCurrentBv}`);
  }
  if (asrQueue.length > 0) parts.push(`队列: ${asrQueue.length} 个`);
  txt.textContent = parts.join(' · ');
}

async function processASRQueue() {
  if (asrBusy || asrQueue.length === 0) return;
  asrBusy = true;
  asrCurrentBv = asrQueue.shift();
  updateAsrBar();

  try {
    const whisperModel = document.getElementById('whisper-model').value;
    const keepAudio = false; // 后续可从设置读取
    const r = await fetch(API + '/api/extract_subtitle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bv_id: asrCurrentBv, whisper_model: whisperModel, keep_audio: keepAudio })
    });
    if (!r.ok) throw new Error('request failed');

    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          // 只有转写的是当前视频才更新 UI
          if (asrCurrentBv === currentBvId) {
            if (d.progress) { pbShow(d.progress); setSubBadge('warn', '转写中...'); }
            if (d.error) { pbDone(); setSubBadge('off', '无字幕', true); }
            if (d.done) {
              pbDone();
              const cnt = d.char_count ? ' ' + fmtChars(d.char_count) : '';
              setSubBadge('ok', '字幕 ✓' + cnt);
              chatSessionId = null;
              notifyContentSubtitleReady();
            }
          }
        } catch {}
      }
    }
  } catch {}

  asrBusy = false;
  asrCurrentBv = null;
  updateAsrBar();
  processASRQueue(); // 处理下一个
}

// ── 通知悬浮窗字幕已就绪 ──
function notifyContentSubtitleReady() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SUBTITLE_READY' }).catch(() => {});
    }
  });
}

// ── 历史对话 ──
let _historySessions = [];
let _historyLoadedBv = null;  // 记录已加载历史的视频，避免轮询重复显示

async function loadHistoryBar() {
  const bar = document.getElementById('history-bar');
  if (!currentBvId || _historyLoadedBv === currentBvId) { bar.style.display = 'none'; return; }
  try {
    const r = await fetch(`${API}/api/chat/sessions?bv_id=${currentBvId}&limit=20`);
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
  // 按时间顺序渲染所有 session 的消息
  for (const session of [..._historySessions].reverse()) {
    try {
      const r = await fetch(`${API}/api/chat/session/${session.id}`);
      if (!r.ok) continue;
      const d = await r.json();
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

async function loadBalance() {
  chrome.runtime.sendMessage({ type: 'GET_BALANCE' }, resp => {
    if (chrome.runtime.lastError || !resp?.cache) return;
    const d = resp.cache;
    const el = document.getElementById('vi-balance');
    if (!el || d.total_balance == null) return;
    el.textContent = '¥' + d.total_balance;
    el.style.color = parseFloat(d.total_balance) < 1 ? '#f55050' : '#888';
  });
  try {
    const r = await fetch(API + '/api/health');
    const d = await r.json();
    if (d.version) {
      const extVer = chrome.runtime.getManifest().version;
      if (d.version !== extVer && !document.getElementById('vi-update-warn')) {
        const el = document.createElement('div');
        el.id = 'vi-update-warn';
        el.style.cssText = 'padding:6px 14px;background:#3a2a10;color:#f5c542;font-size:10px;border-bottom:1px solid #3a3a1a;cursor:pointer';
        el.textContent = '⚠ 版本不一致，请到 chrome://extensions 点刷新';
        el.addEventListener('click', () => chrome.tabs.create({url:'chrome://extensions'}));
        document.querySelector('.video-info')?.after(el);
      }
    }
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

// ── 生成总结（流式积累，done 后渲染结构化）──
document.getElementById('summ-btn').addEventListener('click', async () => {
  if (!currentBvId) return;
  const summBtn = document.getElementById('summ-btn');
  const sendBtn = document.getElementById('c-send');
  const input = document.getElementById('c-input');
  const msgs = document.getElementById('c-msgs');

  const isRedo = summBtn.textContent === '重新总结';
  lockUI(summBtn, sendBtn, input, 'summ');
  pbReset();
  document.getElementById('btn-gen-sub').style.display = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'msg b summ-msg streaming';
  const label = document.createElement('div');
  label.className = 'msg-label'; label.textContent = '视频总结';
  const mainDiv = document.createElement('div');
  mainDiv.style.color = '#9a7858'; mainDiv.textContent = '准备中...';
  bubble.appendChild(label); bubble.appendChild(mainDiv);
  msgs.appendChild(bubble); msgs.scrollTop = msgs.scrollHeight;

  try {
    const r = await fetch(API + '/api/summarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bv_id: currentBvId, model: chatModel,
        whisper_model: document.getElementById('whisper-model').value,
        force: isRedo
      })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      mainDiv.style.color = '#f55050';
      mainDiv.textContent = '错误: ' + (e.detail || r.status);
      return;
    }
    let asrRan = false;
    const fullDelta = [];
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.error) {
            pbDone(); mainDiv.style.color = '#f55050'; mainDiv.textContent = '错误: ' + d.error;
            setSubBadge('off', '无字幕', true); return;
          }
          if (d.progress) {
            mainDiv.style.color = '#9a7858'; mainDiv.textContent = d.progress; pbShow(d.progress);
            if (d.progress.includes('下载音频') || d.progress.includes('加载 Whisper') || d.progress.includes('转写音频')) {
              setSubBadge('warn', '转写中...'); asrRan = true;
            }
          }
          if (d.delta) {
            if (fullDelta.length === 0) {
              mainDiv.textContent = ''; mainDiv.style.color = '';
              setSubBadge('ok', '字幕 ✓');
            }
            fullDelta.push(d.delta);
            mainDiv.textContent += d.delta;
            msgs.scrollTop = msgs.scrollHeight;
          }
          if (d.done) {
            pbDone(); loadBalance();
            if (asrRan) { chatSessionId = null; notifyContentSubtitleReady(); }
            const raw = fullDelta.join('');
            renderSummary(raw, mainDiv);
            bubble._data = { type: 'summary', raw };
            summBtn.textContent = '重新总结';
            msgs.scrollTop = msgs.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    pbDone();
    mainDiv.style.color = '#f55050';
    mainDiv.textContent = '请求失败: ' + e.message;
  } finally {
    bubble.classList.remove('streaming');
    unlockUI(summBtn, sendBtn, input);
  }
});

// ── 对话发送 ──
let lastChatText = '';
let _activeBubble = null;

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

// ── 每视频对话状态缓存 ──
const videoStates = {};

function saveVideoState(bvId) {
  if (!bvId) return;
  const msgs = document.getElementById('c-msgs');
  const messages = [];
  msgs.querySelectorAll('.msg').forEach(el => {
    if (el._data) messages.push(el._data);
  });
  videoStates[bvId] = { sessionId: chatSessionId, messages };
}

function restoreVideoState(bvId) {
  const msgs = document.getElementById('c-msgs');
  msgs.innerHTML = '';
  chatSessionId = null;
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
}

// ── 视频切换检测 + 设置同步 ──
let lastBv = null;
setInterval(async () => {
  const prevBvId = currentBvId;
  await Promise.all([loadVideoInfo(), loadSettings()]); // 设置有变化才真正执行，否则立即返回
  if (currentBvId && currentBvId !== lastBv) {
    saveVideoState(prevBvId);
    lastBv = currentBvId;
    _historyLoadedBv = null;
    restoreVideoState(currentBvId);
    // 切到新视频时，若该视频已在队列中则提升到队首
    if (asrQueue.includes(currentBvId)) enqueueASR(currentBvId);
  }
}, 1000);

// 先加载设置再初始化视频信息，确保 autoAsr 状态正确
loadSettings().finally(() => loadVideoInfo());
