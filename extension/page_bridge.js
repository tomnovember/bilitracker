/**
 * BiliTracker Page Bridge
 * 运行在MAIN世界（页面上下文），可以访问 window.__INITIAL_STATE__
 * 把数据写到DOM元素供content.js（ISOLATED世界）读取
 */
(function() {
  // ── 拦截播放器字幕请求 ──
  // B站播放器自己会请求aisubtitle/subtitle的JSON，我们拦截fetch捕获URL
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = (typeof input === "string") ? input : (input?.url || "");
    if (url.includes("aisubtitle") || (url.includes("/bfs/subtitle/") && url.includes(".json"))) {
      console.log("[BiliTracker Bridge] 拦截到字幕URL:", url.substring(0, 100));
      try {
        const bridge = document.getElementById("__bt_state_bridge");
        if (bridge) bridge.setAttribute("data-subtitle-url", url);
      } catch {}
    }
    return origFetch.apply(this, arguments);
  };

  // 也拦截XHR以防播放器用的是XHR
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === "string" && (url.includes("aisubtitle") || (url.includes("/bfs/subtitle/") && url.includes(".json")))) {
      console.log("[BiliTracker Bridge] XHR拦截到字幕URL:", url.substring(0, 100));
      try {
        const bridge = document.getElementById("__bt_state_bridge");
        if (bridge) bridge.setAttribute("data-subtitle-url", url);
      } catch {}
    }
    return origXHROpen.apply(this, arguments);
  };

  function extractAndBridge() {
    try {
      const d = window.__INITIAL_STATE__;
      if (!d || !d.videoData) return false;

      // 移除旧bridge
      document.getElementById("__bt_state_bridge")?.remove();

      const el = document.createElement("div");
      el.id = "__bt_state_bridge";
      el.style.display = "none";
      el.setAttribute("data-ready", "1");
      el.textContent = JSON.stringify({
        videoData: {
          bvid: d.videoData.bvid,
          aid: d.videoData.aid,
          title: d.videoData.title,
          desc: d.videoData.desc,
          pic: d.videoData.pic,
          duration: d.videoData.duration,
          pubdate: d.videoData.pubdate,
          cid: d.videoData.cid,
          tname: d.videoData.tname,
          stat: d.videoData.stat ? {
            view: d.videoData.stat.view,
            danmaku: d.videoData.stat.danmaku,
            like: d.videoData.stat.like,
            coin: d.videoData.stat.coin,
            favorite: d.videoData.stat.favorite,
            share: d.videoData.stat.share,
            reply: d.videoData.stat.reply
          } : {},
          subtitle: d.videoData.subtitle ? {
            list: (d.videoData.subtitle.list || []).map(function(s) {
              return {
                lan: s.lan, lan_doc: s.lan_doc, subtitle_url: s.subtitle_url || null,
                ai_type: s.ai_type, ai_status: s.ai_status
              };
            })
          } : { list: [] },
          pages: (d.videoData.pages || []).map(function(p) {
            return { cid: p.cid, part: p.part };
          })
        },
        upData: {
          mid: d.upData ? d.upData.mid : null,
          name: d.upData ? d.upData.name : null,
          fans: d.upData ? d.upData.fans : null
        },
        tags: (d.tags || []).map(function(t) {
          return { tag_name: t.tag_name || t };
        })
      });
      document.body.appendChild(el);
      return true;
    } catch(e) {
      return false;
    }
  }

  // 立即尝试，如果没准备好就轮询
  if (!extractAndBridge()) {
    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      if (extractAndBridge() || attempts > 30) {
        clearInterval(timer);
      }
    }, 500);
  }

  // 监听SPA路由变化，重新提取
  var lastUrl = location.href;
  setInterval(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 等页面数据更新
      setTimeout(function() {
        extractAndBridge();
        fetchSubtitleUrl(); // 路由切换后重新获取字幕
      }, 1500);
    }
  }, 1000);

  // ── 主动获取字幕URL ──
  function fetchSubtitleUrl() {
    var d = window.__INITIAL_STATE__;
    if (!d || !d.videoData) return;
    var bvid = d.videoData.bvid;
    var cid = d.videoData.cid;
    if (!bvid || !cid) return;

    // 先检查__INITIAL_STATE__里是否已有subtitle_url
    var subList = (d.videoData.subtitle && d.videoData.subtitle.list) || [];
    for (var i = 0; i < subList.length; i++) {
      if (subList[i].subtitle_url && subList[i].subtitle_url.length > 5) {
        var bridge = document.getElementById("__bt_state_bridge");
        if (bridge) bridge.setAttribute("data-subtitle-url", subList[i].subtitle_url);
        console.log("[BiliTracker Bridge] 从INITIAL_STATE获取到字幕URL");
        return;
      }
    }

    // 没有URL → 调 /x/player/wbi/v2（带wts+cookie即可，无需签名）
    var wts = Math.round(Date.now() / 1000);
    var apiUrl = "https://api.bilibili.com/x/player/wbi/v2?bvid=" + bvid + "&cid=" + cid + "&wts=" + wts;
    console.log("[BiliTracker Bridge] 请求字幕URL...");

    origFetch(apiUrl, { credentials: "include" })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || data.code !== 0) {
          console.warn("[BiliTracker Bridge] player API返回:", data && data.code, data && data.message);
          return;
        }
        var subtitles = (data.data && data.data.subtitle && data.data.subtitle.subtitles) || [];
        if (subtitles.length === 0) { console.log("[BiliTracker Bridge] API返回无字幕"); return; }

        // 优先中文
        var picked = subtitles[0];
        for (var i = 0; i < subtitles.length; i++) {
          if (subtitles[i].lan && subtitles[i].lan.indexOf("zh") !== -1) { picked = subtitles[i]; break; }
        }
        if (picked.subtitle_url) {
          var bridge = document.getElementById("__bt_state_bridge");
          if (bridge) {
            bridge.setAttribute("data-subtitle-url", picked.subtitle_url);
            console.log("[BiliTracker Bridge] 获取字幕URL成功:", picked.subtitle_url.substring(0, 80));
          }
        } else {
          console.warn("[BiliTracker Bridge] subtitle_url为空");
        }
      })
      .catch(function(e) {
        console.warn("[BiliTracker Bridge] 字幕获取失败:", e);
      });
  }

  // bridge创建后获取字幕URL
  setTimeout(fetchSubtitleUrl, 2000);
})();
