(function () {
  "use strict";

  /* ---------- 给 AI 的提示词（与 schema.md 保持一致） ---------- */
  var PROMPT = [
    "你是一个英语学习数据生成器。把下面的英文文章转换成严格 JSON，只输出 JSON，不要任何解释，不要 Markdown 代码块围栏。",
    "",
    "输出结构：",
    "{",
    '  "title": "文章标题",',
    '  "sentences": [',
    "    {",
    '      "en": "原句，必须与原文完全一致",',
    '      "zh": "该句的自然中文翻译",',
    '      "words": {',
    '        "word": { "zh": "该词在本句中的义项", "pos": "n.", "ipa": "/wɜːrd/" }',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "要求：",
    "1. 按原文句子切分，一句一个对象，不合并不拆分，标点保留在 en 里。",
    "2. en 与原文逐字一致，不改写、不润色、不改大小写。",
    "3. zh 是整句流畅中文，不要逐词硬译。",
    "4. words 的键是句中出现的原词形（小写）。值里：",
    "   - zh：该词在此句语境中的义项（不是字典首义），中文，简洁；",
    "   - pos：词性缩写 n. / v. / adj. / adv. / prep. / pron. / conj. / art. / num. / int.；",
    "   - ipa：美式音标，用 / / 包裹；没有把握就省略该字段，不要编造。",
    "5. 覆盖句中所有单词，包括冠词、介词、连词，给最简释义。",
    "6. 人名、地名保留原样，在 zh 里注明。",
    "7. 同一句里同一个词只保留一个键。",
    "",
    "文章：",
    "【在这里粘贴你的英文文章】"
  ].join("\n");

  var SAMPLE = [
    "{",
    '  "title": "A Short Example",',
    '  "sentences": [',
    "    {",
    '      "en": "The bakery opens early.",',
    '      "zh": "这家面包店开门很早。",',
    '      "words": {',
    '        "the": { "zh": "这（定冠词）", "pos": "art.", "ipa": "/ðə/" },',
    '        "bakery": { "zh": "面包店", "pos": "n.", "ipa": "/ˈbeɪkəri/" },',
    '        "opens": { "zh": "开门（第三人称单数）", "pos": "v.", "ipa": "/ˈoʊpənz/" },',
    '        "early": { "zh": "早", "pos": "adv.", "ipa": "/ˈɜːrli/" }',
    "      }",
    "    }",
    "  ]",
    "}"
  ].join("\n");

  var STORE_KEY = "en-reader.state.v1";
  var WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+(?:[.,:]\d+)*/g;

  var LOG_ENABLED = true;
  var LOG_PREFIX = "[LIGHT]";
  var VOICE_RETRY_MAX = 30;
  var VOICE_RETRY_MS = 100;
  var voiceRetryCount = 0;
  var voiceRetryTimer = 0;

  /* ---------- 滚轮翻句 ---------- */
  var WHEEL_THRESHOLD = 100;   // 鼠标一格 ≈ 100px；触控板累积到阈值才翻
  var WHEEL_COOLDOWN_MS = 250; // 翻句后冷却，吃掉触控板惯性
  var WHEEL_IDLE_MS = 150;     // 事件间隔超过此值视为新手势
  var wheelAccum = 0;          // 带符号的累计 delta（像素）
  var wheelLastEventAt = 0;
  var wheelLastFlipAt = 0;
  var wheelLocked = false;     // 一次手势内只允许翻一句

  function log() {
    if (!LOG_ENABLED) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX);
    console.log.apply(console, args);
  }

  function logError() {
    if (!LOG_ENABLED) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX + " ERROR");
    console.error.apply(console, args);
  }

  var state = { idx: 0, showZh: false, auto: false, mask: false, data: null, voiceURI: "", rate: 1 };
  var voice = null;
  var toastTimer = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- 数据结构校验 ---------- */
  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("JSON 根节点必须是一个对象");
    }
    if (!Array.isArray(raw.sentences) || raw.sentences.length === 0) {
      throw new Error("缺少非空的 sentences 数组");
    }
    raw.sentences.forEach(function (s, i) {
      if (!s || typeof s.en !== "string" || !s.en.trim()) {
        throw new Error("第 " + (i + 1) + " 句缺少 en 字段");
      }
      if (typeof s.zh !== "string") s.zh = "";
      if (!s.words || typeof s.words !== "object" || Array.isArray(s.words)) s.words = {};
    });
    return {
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled",
      sentences: raw.sentences
    };
  }

  /* ---------- 渲染 ---------- */
  function tokenize(text, dict) {
    var out = "";
    var last = 0;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      var raw = m[0];
      var key = raw.toLowerCase();
      var has = Object.prototype.hasOwnProperty.call(dict, key);
      out += '<span class="w' + (has ? " has-def" : "") +
        '" data-w="' + esc(key) + '" data-start="' + m.index +
        '" tabindex="0" role="button" aria-label="' + esc(raw) + '">' + esc(raw) + "</span>";
      last = m.index + raw.length;
    }
    out += esc(text.slice(last));
    return out;
  }

  function render() {
    var s = state.data.sentences[state.idx];
    log("render: idx", state.idx, "title", state.data.title,
      "showZh", state.showZh, "auto", state.auto, "mask", state.mask, "rate", state.rate);
    $("title").textContent = state.data.title;
    document.title = state.data.title + " · U32";
    $("sentence").innerHTML = tokenize(s.en, s.words);
    $("sentence").classList.toggle("masked", state.mask);
    $("translation").textContent = s.zh || "";
    $("translation").hidden = !state.showZh || !s.zh;
    $("btn-zh").classList.toggle("active", state.showZh);
    $("btn-mask").classList.toggle("active", state.mask);
    $("btn-mask").setAttribute("aria-pressed", String(state.mask));
    $("progress").textContent = (state.idx + 1) + " / " + state.data.sentences.length;
    bindWords();
    closeCard();
    if (state.auto) speak(s.en);
    persist();
  }

  function bindWords() {
    var nodes = $("sentence").querySelectorAll(".w");
    Array.prototype.forEach.call(nodes, function (el) {
      el.tabIndex = state.mask ? -1 : 0;
      if (state.mask) return;
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        openCard(el);
      });
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCard(el);
        }
      });
    });
  }

  /* ---------- 词卡 ---------- */
  function openCard(el) {
    log("openCard:", el.textContent, "key", el.getAttribute("data-w"));
    var key = el.getAttribute("data-w");
    var s = state.data.sentences[state.idx];
    var def = s.words[key];
    var card = $("wordcard");

    Array.prototype.forEach.call(document.querySelectorAll(".w.active"), function (n) {
      n.classList.remove("active");
    });
    el.classList.add("active");

    var html = '<div class="wc-head"><span class="wc-word">' + esc(el.textContent) +
      '</span><button class="wc-play" type="button" aria-label="朗读该词">▶</button></div>';
    if (def) {
      if (def.ipa) html += '<div class="wc-ipa">' + esc(def.ipa) + "</div>";
      html += '<div class="wc-def">' +
        (def.pos ? '<span class="wc-pos">' + esc(def.pos) + "</span>" : "") +
        esc(def.zh || "（无释义）") + "</div>";
    } else {
      html += '<div class="wc-miss">这个词没有释义数据，仍可点击发音。若需释义，请在 JSON 的 words 里补上。</div>';
    }

    card.innerHTML = html;
    card.hidden = false;
    place(card, el);
    speak(el.textContent);

    card.querySelector(".wc-play").addEventListener("click", function (e) {
      e.stopPropagation();
      speak(el.textContent);
    });
  }

  function place(card, el) {
    var r = el.getBoundingClientRect();
    card.style.left = "0px";
    card.style.top = "0px";
    var cw = card.offsetWidth;
    var ch = card.offsetHeight;
    var left = r.left + r.width / 2 - cw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - cw - 10));
    var top = r.bottom + 10;
    if (top + ch > window.innerHeight - 10) top = r.top - ch - 10;
    if (top < 10) top = r.bottom + 10;
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function closeCard() {
    var card = $("wordcard");
    if (card) card.hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll(".w.active"), function (n) {
      n.classList.remove("active");
    });
  }

  /* ---------- 朗读 ---------- */
  function allEnglishVoices() {
    if (!("speechSynthesis" in window)) return [];
    return (window.speechSynthesis.getVoices() || []).filter(function (v) {
      return /^en([-_]|$)/i.test(v.lang || "");
    });
  }

  function resetVoiceRetry() {
    voiceRetryCount = 0;
    if (voiceRetryTimer) { clearTimeout(voiceRetryTimer); voiceRetryTimer = 0; }
  }

  function pickVoice() {
    var vs = allEnglishVoices();
    log("pickVoice: attempt", voiceRetryCount, "voices", vs.length, "saved", state.voiceURI || "(none)");
    if (!vs.length) {
      log("pickVoice: no English voices yet");
      return false;
    }
    if (state.voiceURI) {
      var saved = vs.filter(function (v) {
        return (v.voiceURI || v.name) === state.voiceURI;
      })[0];
      if (saved) {
        voice = saved;
        resetVoiceRetry();
        log("pickVoice: restored saved voice", saved.name, saved.lang);
        return true;
      }
      if (voiceRetryCount < VOICE_RETRY_MAX) {
        voiceRetryCount++;
        log("pickVoice: saved voice not loaded yet, retry", voiceRetryCount + "/" + VOICE_RETRY_MAX,
          "current:", vs.map(function (v) { return v.name + " · " + v.lang; }));
        if (voiceRetryTimer) clearTimeout(voiceRetryTimer);
        voiceRetryTimer = setTimeout(function () {
          voiceRetryTimer = 0;
          populateVoices();
        }, VOICE_RETRY_MS);
        return false;
      }
      log("pickVoice: saved voice still missing after retries, fallback", state.voiceURI);
    }
    voice = vs.filter(function (v) { return /^en[-_]US/i.test(v.lang); })[0] ||
      vs.filter(function (v) { return /^en[-_]GB/i.test(v.lang); })[0] ||
      vs[0];
    if (!voice) { log("pickVoice: no usable voice"); return false; }
    var previous = state.voiceURI;
    state.voiceURI = voice.voiceURI || voice.name;
    resetVoiceRetry();
    log("pickVoice: fallback voice", voice.name, voice.lang, "from", previous || "(none)");
    return true;
  }

  function populateVoices() {
    var sel = $("sel-voice");
    if (!sel) return;
    var vs = allEnglishVoices();
    log("populateVoices: start", vs.length, "English voice(s), saved:", state.voiceURI || "(none)");
    sel.innerHTML = "";
    if (!vs.length) {
      var o = document.createElement("option");
      o.value = "";
      o.textContent = "系统暂无英语语音";
      sel.appendChild(o);
      sel.disabled = true;
      log("populateVoices: no voices, select disabled");
      return;
    }
    sel.disabled = false;
    vs.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v.voiceURI || v.name;
      opt.textContent = v.name + " · " + v.lang;
      sel.appendChild(opt);
    });
    pickVoice();
    if (voice) sel.value = voice.voiceURI || voice.name;
    else if (state.voiceURI) {
      var pending = document.createElement("option");
      pending.value = state.voiceURI;
      pending.textContent = "保存的音色（加载中…）";
      sel.insertBefore(pending, sel.firstChild);
      sel.value = state.voiceURI;
      log("populateVoices: showing pending saved voice", state.voiceURI);
    }
    log("populateVoices: done, selected:", sel.value || "(none)");
  }

  function renderRate() {
    var el = $("rate-val");
    if (el) el.textContent = state.rate.toFixed(1) + "×";
    var range = $("range-rate");
    if (range) range.value = String(state.rate);
  }

  function speak(text) {
    log("speak: start", JSON.stringify(text), "rate", state.rate,
      "voice", voice ? voice.name + " · " + voice.lang : "(system default)");
    if (!("speechSynthesis" in window)) {
      logError("speak: speechSynthesis unsupported");
      toast("当前浏览器不支持语音合成，请换用 Chrome / Edge");
      return;
    }
    if (!voice) log("speak: voice not ready, using system default");
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = state.rate;
    if (voice) u.voice = voice;
    u.onboundary = function (e) {
      if (e.name && e.name !== "word") return;
      var spans = $("sentence").querySelectorAll(".w");
      var hit = null;
      Array.prototype.forEach.call(spans, function (sp) {
        sp.classList.remove("reading");
        if (+sp.getAttribute("data-start") <= e.charIndex) hit = sp;
      });
      if (hit) hit.classList.add("reading");
    };
    u.onend = function () { log("speak: end", JSON.stringify(text)); clearReading(); };
    u.onerror = function (e) { logError("speak: error", e, "text", JSON.stringify(text)); clearReading(); };
    window.speechSynthesis.speak(u);
  }

  function clearReading() {
    Array.prototype.forEach.call($("sentence").querySelectorAll(".w"), function (sp) {
      sp.classList.remove("reading");
    });
  }

  /* ---------- 导航 ---------- */
  function go(delta) {
    var next = state.idx + delta;
    if (next < 0 || next >= state.data.sentences.length) {
      log("go: ignored, out of range", delta, "from", state.idx);
      return;
    }
    log("go:", delta, "from", state.idx, "to", next);
    state.idx = next;
    render();
  }

  /* ---------- 滚轮翻句 ---------- */
  function wheelPixels(e) {
    var k = 1;
    if (e.deltaMode === 1) k = 16;             // 行 → 像素
    else if (e.deltaMode === 2) k = window.innerHeight; // 页 → 像素
    return { x: (e.deltaX || 0) * k, y: (e.deltaY || 0) * k };
  }

  function handleWheel(e) {
    var t = e.target;
    if (e.ctrlKey) return; // 缩放手势
    if (t && t.closest && (t.closest(".modal") || t.closest(".popover"))) return;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (anyModalOpen() || !$("voice-pop").hidden) return;

    var d = wheelPixels(e);
    // 横向手势不翻句；纵向在非边界处吞掉原生滚动，边界处放行
    if (!d.y || Math.abs(d.x) > Math.abs(d.y)) { wheelAccum = 0; return; }
    var dir = d.y > 0 ? 1 : -1;
    var next = state.idx + dir;
    if (next < 0 || next >= state.data.sentences.length) {
      wheelAccum = 0;
      log("wheel: at edge, native scroll", dir > 0 ? "next" : "prev", "idx", state.idx);
      return;
    }
    e.preventDefault();

    var now = Date.now();
    var gap = now - wheelLastEventAt;
    wheelLastEventAt = now;
    if (gap > WHEEL_IDLE_MS) { wheelLocked = false; wheelAccum = 0; }
    if (wheelLocked || now - wheelLastFlipAt < WHEEL_COOLDOWN_MS) return;

    if ((wheelAccum > 0 && d.y < 0) || (wheelAccum < 0 && d.y > 0)) wheelAccum = 0;
    wheelAccum += d.y;
    if (Math.abs(wheelAccum) < WHEEL_THRESHOLD) return;

    wheelAccum = 0;
    wheelLastFlipAt = now;
    wheelLocked = true;
    log("wheel:", dir > 0 ? "next" : "prev", state.idx, "->", next,
      "deltaY", Math.round(d.y), "mode", e.deltaMode);
    go(dir);
  }

  /* ---------- 载入数据 ---------- */
  function applyData(obj, sourceLabel) {
    log("applyData:", sourceLabel || "(none)", "title", obj.title, "sentences", obj.sentences.length);
    state.data = obj;
    state.idx = 0;
    render();
    toast("已载入「" + obj.title + "」，共 " + obj.sentences.length + " 句" + (sourceLabel ? "（" + sourceLabel + "）" : ""));
    closeAllModals();
  }

  function fillFromFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      $("paste-box").value = String(fr.result);
      toast("已读取 " + file.name + "，检查后点「载入」");
    };
    fr.onerror = function () { logError("file read failed:", file && file.name); toast("文件读取失败"); };
    fr.readAsText(file);
  }

  function loadFile(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      var parsed;
      try {
        parsed = normalize(JSON.parse(String(fr.result)));
      } catch (err) {
        logError("load JSON failed:", err);
        toast("载入失败：" + err.message);
        return;
      }
      applyData(parsed, file.name);
    };
    fr.onerror = function () { logError("file read failed:", file && file.name); toast("文件读取失败"); };
    fr.readAsText(file);
  }

  function loadPasted() {
    var box = $("paste-box");
    var text = box.value.trim();
    if (!text) {
      toast("先把 JSON 粘贴到文本框里");
      return;
    }
    var parsed;
    try {
      parsed = normalize(JSON.parse(text));
    } catch (err) {
      logError("load pasted JSON failed:", err);
      toast("载入失败：" + err.message);
      return;
    }
    applyData(parsed, "粘贴");
    box.value = "";
  }

  /* ---------- 资料库 ---------- */
  var LIB_STORE_KEY = "en-reader.libraries.v1";
  var LIB_HIDDEN_KEY = "en-reader.libraries.hidden.v1";
  var DEFAULT_LIB_URL = "library/library.json";
  var OFFICIAL_LIB_URL = "https://u32-english-reader-official-library.u32.cn/library.json";
  var DEFAULT_LIBS = [
    { url: DEFAULT_LIB_URL, name: "默认资料库" },
    { url: OFFICIAL_LIB_URL, name: "U32官方资料库" }
  ];
  var LIB_BROWSE_KEY = "en-reader.libbrowse.v1";
  var libs = [];
  var libHidden = [];
  var libCache = {};
  var libFilter = "";
  var libSel = null;
  var libOpen = {};
  var panelFromBrowse = false;

  /* 浏览窗状态：展开项 / 选中项 / 滚动位置，持久化到 localStorage */
  var browseState = { sel: null, scrollTop: 0 };
  var desiredScroll = null;   // 树当前应处的 scrollTop；null = 不接管
  var scrollSaveTimer = 0;
  var revealBusy = false;
  var validateSel = false;

  function resolveUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return ""; }
  }

  /* 展开状态键：跟随「资料库 URL → 系列名 → 书名」，避免下标错位 */
  function libKeyOf(lib) {
    return "lib:" + resolveUrl(lib.url);
  }

  /* 同名兄弟节点用 ~2 / ~3 消歧 */
  function nodeKey(base, siblings, i) {
    var it = siblings && siblings[i];
    var name = it && typeof it.name === "string" ? it.name : String(i);
    var seen = 1;
    for (var k = 0; k < i; k++) {
      if (siblings[k] && siblings[k].name === name) seen++;
    }
    return base + "#n:" + name + (seen > 1 ? "~" + seen : "");
  }

  function loadBrowseState() {
    try {
      var raw = localStorage.getItem(LIB_BROWSE_KEY);
      if (!raw) { log("loadBrowseState: empty"); return; }
      var v = JSON.parse(raw);
      if (!v || typeof v !== "object") return;
      if (v.open && typeof v.open === "object") {
        Object.keys(v.open).forEach(function (k) {
          if (k && (v.open[k] === true || v.open[k] === false)) libOpen[k] = v.open[k];
        });
      }
      if (v.sel && typeof v.sel.url === "string" && v.sel.url) {
        browseState.sel = {
          title: typeof v.sel.title === "string" ? v.sel.title : "",
          level: typeof v.sel.level === "string" ? v.sel.level : "",
          url: v.sel.url,
          path: typeof v.sel.path === "string" ? v.sel.path : "",
          chain: Array.isArray(v.sel.chain) ? v.sel.chain.filter(function (u) {
            return typeof u === "string" && u;
          }) : []
        };
      } else {
        browseState.sel = null;
      }
      browseState.scrollTop = (typeof v.scrollTop === "number" && isFinite(v.scrollTop) && v.scrollTop > 0)
        ? v.scrollTop : 0;
      log("loadBrowseState:", Object.keys(libOpen).length, "open node(s), sel:",
        browseState.sel ? browseState.sel.url : "(none)", "scrollTop:", browseState.scrollTop);
    } catch (e) { logError("loadBrowseState failed:", e); }
  }

  function saveBrowseState() {
    try {
      var box = $("lib-tree");
      var open = {};
      Object.keys(libOpen).forEach(function (k) {
        if (libOpen[k] === true || libOpen[k] === false) open[k] = libOpen[k];
      });
      var sel = libSel ? {
        title: libSel.title, level: libSel.level || "",
        url: libSel.url, path: libSel.path || "", chain: libSel.chain || []
      } : browseState.sel;
      /* 以「意图位置」为准：折叠瞬间 DOM 会被钳位，别把钳位值存下来 */
      var top = desiredScroll !== null ? desiredScroll
        : (box && !$("lib-modal").hidden ? box.scrollTop : browseState.scrollTop);
      browseState.sel = sel;
      browseState.scrollTop = top;
      localStorage.setItem(LIB_BROWSE_KEY, JSON.stringify({
        open: open, sel: sel, scrollTop: top
      }));
      log("saveBrowseState:", Object.keys(open).length, "open node(s), sel:",
        sel ? sel.url : "(none)", "scrollTop:", top);
    } catch (e) { logError("saveBrowseState failed:", e); }
  }

  /* 让树的 scrollTop 保持住：每次重渲染后回填，用户主动滚动时更新目标值 */
  function applyTreeScroll() {
    var box = $("lib-tree");
    if (!box || desiredScroll === null) return;
    if (Math.abs(box.scrollTop - desiredScroll) < 1) return;
    box.scrollTop = desiredScroll;
  }

  function anyModalOpen() {
    return ["lib-modal", "panel", "lib-manage-modal"].some(function (id) {
      var el = $(id);
      return el && !el.hidden;
    });
  }

  function syncScrollLock() {
    document.body.style.overflow = anyModalOpen() ? "hidden" : "";
  }

  function loadLibs() {
    libHidden = [];
    try {
      var rawH = localStorage.getItem(LIB_HIDDEN_KEY);
      if (rawH) {
        var harr = JSON.parse(rawH);
        if (Array.isArray(harr)) {
          libHidden = harr.filter(function (u) { return typeof u === "string" && u; });
        }
      }
    } catch (e) { logError("loadLibs: bad hidden list", e); }

    libs = [];
    DEFAULT_LIBS.forEach(function (d) {
      var hidden = libHidden.some(function (u) {
        return resolveUrl(u) === resolveUrl(d.url);
      });
      if (hidden) { log("loadLibs: hidden default library", d.name); return; }
      libs.push({
        url: d.url, name: d.name, builtin: true,
        state: "idle", data: null, err: ""
      });
    });
    try {
      var raw = localStorage.getItem(LIB_STORE_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach(function (it) {
            if (!it || typeof it.url !== "string" || !it.url) return;
            var abs = resolveUrl(it.url);
            if (!abs || libs.some(function (l) { return resolveUrl(l.url) === abs; })) return;
            libs.push({
              url: it.url, name: typeof it.name === "string" && it.name ? it.name : it.url,
              state: "idle", data: null, err: ""
            });
          });
        }
      }
    } catch (e) { logError("loadLibs: bad localStorage", e); }
    log("loadLibs:", libs.length, "library(ies)");
  }

  function saveLibs() {
    try {
      var out = libs.filter(function (l) { return !l.builtin; }).map(function (l) {
        return { url: l.url, name: l.name };
      });
      localStorage.setItem(LIB_STORE_KEY, JSON.stringify(out));
      log("saveLibs:", out.length, "custom library(ies)");
    } catch (e) { logError("saveLibs failed:", e); }
  }

  function saveHidden() {
    try {
      localStorage.setItem(LIB_HIDDEN_KEY, JSON.stringify(libHidden));
      log("saveHidden:", libHidden.length, "hidden");
    } catch (e) { logError("saveHidden failed:", e); }
  }

  function removeLib(i) {
    var lib = libs[i];
    if (!lib) return;
    var name = libLabel(lib);
    if (lib.builtin) {
      var abs = resolveUrl(lib.url);
      if (libHidden.indexOf(abs) < 0) libHidden.push(abs);
      saveHidden();
    }
    libs.splice(i, 1);
    saveLibs();
    if (libSel && lib.data && libSel.url && lib.data.baseUrl && libSel.url.indexOf(lib.data.baseUrl) === 0) {
      libSel = null;
    }
    renderManageList();
    renderLibTree();
    renderLibMeta();
    toast("已移除资料库：" + name + (lib.builtin ? "（可在本页恢复）" : ""));
    log("removeLib:", name);
  }

  function restoreDefaultLib() {
    DEFAULT_LIBS.forEach(function (d) {
      var abs = resolveUrl(d.url);
      libHidden = libHidden.filter(function (u) { return resolveUrl(u) !== abs; });
      var exists = libs.some(function (l) { return resolveUrl(l.url) === abs; });
      if (!exists) {
        libs.push({
          url: d.url, name: d.name, builtin: true,
          state: "idle", data: null, err: ""
        });
      }
    });
    saveHidden();
    renderManageList();
    renderLibTree();
    prefetchLibs();
    toast("已恢复默认资料库");
    log("restoreDefaultLib");
  }

  var childIndexCache = {};

  function countValue(v) {
    return typeof v === "number" && isFinite(v) ? v : undefined;
  }

  function nodeCount(node) {
    if (!node) return 0;
    if (typeof node.count === "number") return node.count;
    if (Array.isArray(node.articles)) return node.articles.length;
    if (Array.isArray(node.books)) {
      return node.books.reduce(function (n, b) { return n + nodeCount(b); }, 0);
    }
    return 0;
  }

  function normalizeArticleList(raw, indexUrl) {
    return raw.filter(function (a) {
      return a && typeof a.file === "string" && a.file;
    }).map(function (a) {
      return {
        title: typeof a.title === "string" && a.title.trim() ? a.title.trim() : a.file,
        level: typeof a.level === "string" ? a.level : "",
        url: new URL(a.file, indexUrl).href
      };
    });
  }

  function normalizeChildIndex(raw, indexUrl, kind) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("子索引根节点必须是一个对象");
    }
    if (kind === "series") {
      if (!Array.isArray(raw.books)) throw new Error("系列索引缺少 books 数组");
      return {
        books: raw.books.map(function (b, j) {
          if (!b || typeof b.name !== "string" || !b.name.trim()) {
            throw new Error("系列索引第 " + (j + 1) + " 本书缺少 name");
          }
          if (typeof b.index !== "string" || !b.index) {
            throw new Error("书「" + b.name + "」缺少 index");
          }
          return {
            name: b.name.trim(),
            indexUrl: new URL(b.index, indexUrl).href,
            articles: [],
            count: countValue(b.articleCount),
            loaded: false,
            loading: false,
            state: "idle",
            err: ""
          };
        })
      };
    }
    if (!Array.isArray(raw.articles)) throw new Error("书索引缺少 articles 数组");
    return { articles: normalizeArticleList(raw.articles, indexUrl) };
  }

  var pendingIndexFetches = 0;

  function fetchChildIndex(url, kind) {
    if (childIndexCache[url]) return childIndexCache[url];
    pendingIndexFetches++;
    var p = fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (raw) {
      return normalizeChildIndex(raw, url, kind);
    });
    childIndexCache[url] = p;
    p.catch(function () { delete childIndexCache[url]; })
      .then(function () { pendingIndexFetches--; });
    return p;
  }

  function loadSeriesChildren(lib, s) {
    if (!s.indexUrl || s.loaded) return Promise.resolve();
    if (s.loading) return s.promise || Promise.resolve();
    s.loading = true;
    s.state = "loading";
    s.err = "";
    renderLibTree();
    var p = fetchChildIndex(s.indexUrl, "series").then(function (data) {
      s.books = data.books;
      s.loaded = true;
      s.state = "ok";
    }).catch(function (err) {
      s.state = "error";
      s.err = err.message;
      logError("series index failed:", s.indexUrl, err);
    }).then(function () {
      s.loading = false;
      renderLibTree();
    });
    s.promise = p;
    return p;
  }

  function loadBookChildren(lib, b) {
    if (!b.indexUrl || b.loaded) return Promise.resolve();
    if (b.loading) return b.promise || Promise.resolve();
    b.loading = true;
    b.state = "loading";
    b.err = "";
    renderLibTree();
    var p = fetchChildIndex(b.indexUrl, "book").then(function (data) {
      b.articles = data.articles;
      b.loaded = true;
      b.state = "ok";
    }).catch(function (err) {
      b.state = "error";
      b.err = err.message;
      logError("book index failed:", b.indexUrl, err);
    }).then(function () {
      b.loading = false;
      renderLibTree();
    });
    b.promise = p;
    return p;
  }

  function ensureAllIndexes() {
    var jobs = [];
    libs.forEach(function (lib) {
      var idx = lib.data;
      if (!idx || idx.version !== 2) return;
      idx.series.forEach(function (s) {
        jobs.push(loadSeriesChildren(lib, s).then(function () {
          return Promise.all(s.books.map(function (b) { return loadBookChildren(lib, b); }));
        }));
      });
    });
    return Promise.all(jobs);
  }

  /* 按文章 URL 反查祖先并展开（只在数据已就位时才找得到） */
  function revealByLoadedData(want) {
    var hit = false;
    libs.forEach(function (lib) {
      var idx = lib.data;
      if (!idx) return;
      var lk = libKeyOf(lib);
      idx.series.forEach(function (s, si) {
        var books = Array.isArray(s.books) ? s.books : [];
        books.forEach(function (b, bi) {
          var arts = Array.isArray(b.articles) ? b.articles : [];
          if (!arts.some(function (a) { return a && a.url === want; })) return;
          hit = true;
          libOpen[lk] = true;
          libOpen[nodeKey(lk, idx.series, si)] = true;
          libOpen[nodeKey(nodeKey(lk, idx.series, si), books, bi)] = true;
        });
      });
    });
    return hit;
  }

  /* 文章是否还在已加载的索引里（不管当前是否展开） */
  function selExistsAnywhere(url) {
    var yes = false;
    libs.forEach(function (lib) {
      var idx = lib.data;
      if (!idx || yes) return;
      idx.series.forEach(function (s) {
        (s.books || []).forEach(function (b) {
          if (yes) return;
          if ((b.articles || []).some(function (a) { return a && a.url === url; })) yes = true;
        });
      });
    });
    return yes;
  }

  /* 恢复上次选中项：先看已就位数据，再按保存的索引链补拉子索引 */
  function revealSavedSelection() {
    var sel = browseState.sel;
    if (!sel || !sel.url) return Promise.resolve(false);
    if (revealByLoadedData(sel.url)) { renderLibTree(); return Promise.resolve(true); }

    var chain = sel.chain || [];
    if (!chain.length) return Promise.resolve(false);

    var jobs = [];
    libs.forEach(function (lib) {
      var idx = lib.data;
      if (!idx) return;
      var lk = libKeyOf(lib);
      idx.series.forEach(function (s, si) {
        if (chain.indexOf(s.indexUrl) < 0) return;
        var sk = nodeKey(lk, idx.series, si);
        jobs.push(loadSeriesChildren(lib, s).then(function () {
          var books = Array.isArray(s.books) ? s.books : [];
          books.forEach(function (b, bi) {
            if (chain.indexOf(b.indexUrl) < 0) return;
            jobs.push(loadBookChildren(lib, b));
          });
        }));
      });
    });
    return Promise.all(jobs).then(function () {
      return revealByLoadedData(sel.url);
    });
  }

  /* 数据到齐后确认上次的选中项是否真的不存在了（祖先折叠不算消失） */
  function validateSavedSelection() {
    if (!validateSel) return;
    if (!libSel) { validateSel = false; return; }
    var busy = revealBusy || pendingIndexFetches > 0 ||
      libs.some(function (l) { return l.state === "loading" || l.state === "idle"; });
    if (busy) return;
    if (selExistsAnywhere(libSel.url)) { validateSel = false; return; }
    if (revealByLoadedData(libSel.url)) { validateSel = false; renderLibTree(); return; }
    log("validateSavedSelection: gone, clear", libSel.url);
    libSel = null;
    validateSel = false;
    renderLibTree();
    saveBrowseState();
  }

  function revealAndRender() {
    if (revealBusy) { renderLibTree(); return; }
    revealBusy = true;
    revealSavedSelection().then(function () {
      revealBusy = false;
      renderLibTree();
      applyTreeScroll();
      validateSavedSelection();
    }).catch(function (err) {
      revealBusy = false;
      logError("revealSavedSelection failed:", err);
      renderLibTree();
      applyTreeScroll();
      validateSavedSelection();
    });
  }

  function normalizeLibrary(raw, indexUrl) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("索引根节点必须是一个对象");
    }
    if (!Array.isArray(raw.series) || raw.series.length === 0) {
      throw new Error("缺少非空的 series 数组");
    }
    var libName = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "未命名资料库";
    if (raw.version === 2) {
      var v2Series = raw.series.map(function (s, i) {
        if (!s || typeof s.name !== "string" || !s.name.trim()) {
          throw new Error("第 " + (i + 1) + " 个系列缺少 name");
        }
        if (typeof s.index !== "string" || !s.index) {
          throw new Error("系列「" + s.name + "」缺少 index");
        }
        return {
          name: s.name.trim(),
          indexUrl: new URL(s.index, indexUrl).href,
          books: [],
          count: countValue(s.articleCount),
          loaded: false,
          loading: false,
          state: "idle",
          err: ""
        };
      });
      return {
        name: libName,
        description: typeof raw.description === "string" ? raw.description : "",
        version: 2,
        series: v2Series,
        count: countValue(raw.articleCount),
        baseUrl: indexUrl
      };
    }
    var series = raw.series.map(function (s, i) {
      if (!s || typeof s.name !== "string" || !s.name.trim()) {
        throw new Error("第 " + (i + 1) + " 个系列缺少 name");
      }
      var books = Array.isArray(s.books) ? s.books.map(function (b, j) {
        if (!b || typeof b.name !== "string" || !b.name.trim()) {
          throw new Error("系列「" + s.name + "」第 " + (j + 1) + " 本书缺少 name");
        }
        var articles = Array.isArray(b.articles) ? b.articles.filter(function (a) {
          return a && typeof a.file === "string" && a.file;
        }).map(function (a) {
          return {
            title: typeof a.title === "string" && a.title.trim() ? a.title.trim() : a.file,
            level: typeof a.level === "string" ? a.level : "",
            url: new URL(a.file, indexUrl).href
          };
        }) : [];
        return { name: b.name.trim(), articles: articles };
      }) : [];
      return { name: s.name.trim(), books: books };
    });
    return {
      name: libName,
      version: 1,
      series: series,
      baseUrl: indexUrl
    };
  }

  function fetchIndex(lib) {
    var url = resolveUrl(lib.url);
    if (!url) return Promise.reject(new Error("资料库网址不合法"));
    if (libCache[url]) return Promise.resolve(libCache[url]);
    log("fetchIndex:", url);
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      log("fetchIndex: status", r.status, url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (raw) {
      var idx = normalizeLibrary(raw, url);
      idx.url = url;
      libCache[url] = idx;
      return idx;
    });
  }

  function libArticleCount(idx) {
    if (!idx) return 0;
    if (typeof idx.count === "number") return idx.count;
    return idx.series.reduce(function (n, s) { return n + nodeCount(s); }, 0);
  }

  function libLabel(lib) {
    var dup = libs.filter(function (l) { return l.name === lib.name; }).length > 1;
    if (!dup) return lib.name;
    try { return lib.name + " · " + new URL(resolveUrl(lib.url)).host; } catch (e) { return lib.name; }
  }

  function prefetchLibs() {
    libs.forEach(function (lib) {
      if (lib.state === "loading" || lib.state === "ok") return;
      lib.state = "loading";
      fetchIndex(lib).then(function (idx) {
        lib.state = "ok";
        lib.data = idx;
        lib.err = "";
        if (idx.name && idx.name !== lib.name) {
          lib.name = idx.name;
          if (!lib.builtin) saveLibs();
        }
        log("library ok:", lib.name, libArticleCount(idx), "article(s)");
        redrawLibraryUI();
      }).catch(function (err) {
        lib.state = "error";
        lib.err = err.message;
        logError("library index failed:", lib.url, err);
        redrawLibraryUI();
      });
    });
  }

  function redrawLibraryUI() {
    if (!$("lib-modal").hidden) {
      renderLibTree();
      if (validateSel) revealAndRender();
    }
    if (!$("lib-manage-modal").hidden) renderManageList();
  }

  function libVisible(name, q) {
    return !q || String(name).toLowerCase().indexOf(q) >= 0;
  }

  function renderLibTree() {
    var box = $("lib-tree");
    if (!box) return;
    box.innerHTML = "";
    if (!libs.length) {
      var p0 = document.createElement("p");
      p0.className = "lib-empty";
      p0.textContent = "还没有资料库，点下方「资料库管理」添加";
      box.appendChild(p0);
      renderLibMeta();
      applyTreeScroll();
      return;
    }
    var q = libFilter.trim().toLowerCase();
    var shown = 0;

    libs.forEach(function (lib, li) {
      var lKey = libKeyOf(lib);
      var libHit = libVisible(lib.name, q);
      var idx = lib.data;
      var seriesViews = [];

      if (idx) {
        idx.series.forEach(function (s, si) {
          var sHit = libHit || libVisible(s.name, q);
          var bookViews = [];
          s.books.forEach(function (b, bi) {
            var bHit = sHit || libVisible(b.name, q);
            var arts = b.articles.filter(function (a) {
              return bHit || libVisible(a.title, q);
            });
            if (q && !bHit && !arts.length) return;
            bookViews.push({ b: b, bi: bi, arts: arts });
          });
          if (q && !sHit && !bookViews.length) return;
          seriesViews.push({ s: s, si: si, books: bookViews });
        });
      }

      if (q && !libHit && !seriesViews.length) return;
      shown++;

      var lOpen = q ? true : libOpen[lKey] !== false;
      box.appendChild(libRowElem("lib", {
        label: libLabel(lib),
        libIndex: li,
        open: lOpen,
        caret: true,
        state: lib.state,
        err: lib.err,
        count: idx ? libArticleCount(idx) : null,
        onToggle: function () {
          if (lib.state === "error") {
            lib.state = "idle";
            prefetchLibs();
            return;
          }
          if (lib.state === "loading") { toast("索引读取中，稍等"); return; }
          libOpen[lKey] = !lOpen;
          saveBrowseState();
          renderLibTree();
        }
      }));

      if (!lOpen || !idx) return;

      seriesViews.forEach(function (sv) {
        var sKey = nodeKey(lKey, idx.series, sv.si);
        var sOpen = q ? true : (sv.s.indexUrl ? libOpen[sKey] === true : libOpen[sKey] !== false);
        box.appendChild(libRowElem("series", {
          label: sv.s.name,
          open: sOpen,
          caret: true,
          count: nodeCount(sv.s),
          state: sv.s.state,
          err: sv.s.err,
          onToggle: function () {
            libOpen[sKey] = !sOpen;
            saveBrowseState();
            if (!sOpen && sv.s.indexUrl && (sv.s.state !== "ok" || !sv.s.loaded)) {
              loadSeriesChildren(lib, sv.s);
            }
            renderLibTree();
          }
        }));
        if (!sOpen) return;

        sv.books.forEach(function (bv) {
          var bKey = nodeKey(sKey, sv.s.books, bv.bi);
          var bOpen = q ? true : (bv.b.indexUrl ? libOpen[bKey] === true : libOpen[bKey] !== false);
          box.appendChild(libRowElem("book", {
            label: bv.b.name,
            open: bOpen,
            caret: true,
            count: nodeCount(bv.b),
            state: bv.b.state,
            err: bv.b.err,
            onToggle: function () {
              libOpen[bKey] = !bOpen;
              saveBrowseState();
              if (!bOpen && bv.b.indexUrl && (bv.b.state !== "ok" || !bv.b.loaded)) {
                loadBookChildren(lib, bv.b);
              }
              renderLibTree();
            }
          }));
          if (!bOpen) return;

          var chain = [];
          if (sv.s.indexUrl) chain.push(sv.s.indexUrl);
          if (bv.b.indexUrl) chain.push(bv.b.indexUrl);

          bv.arts.forEach(function (a) {
            var selected = !!(libSel && libSel.url === a.url);
            var pick = function () {
              libSel = {
                title: a.title, level: a.level, url: a.url,
                path: lib.name + " › " + sv.s.name + " › " + bv.b.name,
                chain: chain
              };
            };
            box.appendChild(libRowElem("article", {
              label: a.title,
              level: a.level,
              selected: selected,
              onClick: function () {
                pick();
                saveBrowseState();
                renderLibTree();
              },
              onDblClick: function () {
                pick();
                loadSelectedArticle();
              }
            }));
          });
        });
      });
    });

    if (!shown) {
      var empty = document.createElement("p");
      empty.className = "lib-empty";
      empty.textContent = q ? "没有匹配的条目" : "资料库还没有内容";
      box.appendChild(empty);
    }
    renderLibMeta();

    applyTreeScroll();
  }

  function libRowElem(kind, opt) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "lib-item lib-" + kind + (opt.selected ? " selected" : "");
    row.setAttribute("role", "treeitem");
    if (typeof opt.libIndex === "number") row.setAttribute("data-lib", String(opt.libIndex));

    if (opt.caret) {
      var c = document.createElement("span");
      c.className = "lib-caret";
      c.textContent = opt.open ? "▾" : "▸";
      row.appendChild(c);
    } else {
      var d = document.createElement("span");
      d.className = "lib-dot";
      row.appendChild(d);
    }

    var t = document.createElement("span");
    t.className = "lib-label";
    t.textContent = opt.label;
    row.appendChild(t);

    if (opt.state === "loading") {
      var st = document.createElement("span");
      st.className = "lib-state";
      st.textContent = "读取中…";
      row.appendChild(st);
    } else if (opt.state === "error") {
      var se = document.createElement("span");
      se.className = "lib-state bad";
      se.textContent = "读取失败，点击重试";
      se.title = opt.err || "";
      row.appendChild(se);
    } else if (opt.level) {
      var lv = document.createElement("span");
      lv.className = "lib-level";
      lv.textContent = opt.level;
      row.appendChild(lv);
    }

    if (typeof opt.count === "number") {
      var ct = document.createElement("span");
      ct.className = "lib-count";
      ct.textContent = String(opt.count);
      row.appendChild(ct);
    }

    if (opt.onToggle) row.addEventListener("click", opt.onToggle);
    if (opt.onClick) row.addEventListener("click", opt.onClick);
    if (opt.onDblClick) row.addEventListener("dblclick", opt.onDblClick);
    return row;
  }

  function renderLibMeta() {
    var meta = $("lib-meta");
    var btn = $("btn-lib-load");
    if (!meta || !btn) return;
    if (libSel) {
      meta.textContent = libSel.title + (libSel.level ? " · " + libSel.level : "");
      meta.title = libSel.path + " › " + libSel.title;
      btn.disabled = false;
    } else {
      var total = libs.reduce(function (n, l) { return n + libArticleCount(l.data); }, 0);
      meta.textContent = libs.length + " 个资料库 · " + total + " 篇 · 双击直接载入";
      meta.title = "";
      btn.disabled = true;
    }
  }

  function openBrowse() {
    var modal = $("lib-modal");
    if (!modal) return;
    libFilter = "";
    $("lib-filter").value = "";
    $("lib-sub").textContent = "资料库 → 系列 → 书 → 文章";
    loadBrowseState();
    libSel = browseState.sel;
    desiredScroll = browseState.scrollTop;
    validateSel = true;
    modal.hidden = false;
    syncScrollLock();
    renderLibTree();
    applyTreeScroll();
    log("openBrowse: restore sel:", libSel ? libSel.url : "(none)", "scrollTop:", desiredScroll);
    revealAndRender();
    prefetchLibs();
    /* 首屏内容不够高时 scrollTop 会被钳掉，布局稳定后再补一次 */
    requestAnimationFrame(applyTreeScroll);
  }

  function closeBrowse() {
    var modal = $("lib-modal");
    if (!modal || modal.hidden) return;
    saveBrowseState();
    modal.hidden = true;
    libSel = null;
    desiredScroll = null;
    validateSel = false;
    syncScrollLock();
  }

  function closeAllModals() {
    if (!$("lib-modal").hidden) saveBrowseState();
    ["lib-modal", "panel", "lib-manage-modal"].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    libSel = null;
    desiredScroll = null;
    validateSel = false;
    panelFromBrowse = false;
    syncScrollLock();
  }

  function loadSelectedArticle() {
    if (!libSel) { toast("先选一篇文章"); return; }
    var target = libSel;
    toast("正在载入：" + target.title);
    fetch(target.url, { cache: "no-cache" }).then(function (r) {
      log("article fetch: status", r.status, target.url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (raw) {
      var parsed = normalize(raw);
      log("article loaded from library:", target.url, parsed.title);
      closeAllModals();
      applyData(parsed, target.title);
    }).catch(function (err) {
      logError("loadSelectedArticle failed:", target.url, err);
      toast("文章载入失败：" + err.message);
    });
  }

  /* ---------- 资料库管理 ---------- */
  function openManage() {
    var m = $("lib-manage-modal");
    if (!m) return;
    m.hidden = false;
    syncScrollLock();
    renderManageList();
    prefetchLibs();
  }

  function closeManage() {
    var m = $("lib-manage-modal");
    if (!m || m.hidden) return;
    m.hidden = true;
    syncScrollLock();
  }

  function renderManageList() {
    var box = $("lib-list");
    if (!box) return;
    box.innerHTML = "";
    libs.forEach(function (lib, i) {
      var row = document.createElement("div");
      row.className = "lib-row";

      var main = document.createElement("div");
      main.className = "lib-row-main";
      var nm = document.createElement("span");
      nm.className = "lib-name";
      nm.textContent = libLabel(lib);
      var uu = document.createElement("span");
      uu.className = "lib-url";
      uu.textContent = lib.state === "error"
        ? "读取失败：" + resolveUrl(lib.url)
        : resolveUrl(lib.url);
      if (lib.state === "error") uu.classList.add("bad");
      main.appendChild(nm);
      main.appendChild(uu);
      row.appendChild(main);

      var acts = document.createElement("div");
      acts.className = "lib-row-acts";
      var openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "lib-open";
      openBtn.textContent = "查看";
      openBtn.addEventListener("click", function () {
        closeManage();
        if ($("lib-modal").hidden) openBrowse();
        libOpen["l" + i] = true;
        renderLibTree();
        var target = document.querySelector('.lib-item[data-lib="' + i + '"]');
        if (target && target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
      });
      acts.appendChild(openBtn);
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "lib-del";
      delBtn.textContent = "移除";
      delBtn.title = "从列表移除（不删除仓库文件）";
      delBtn.addEventListener("click", function () {
        removeLib(i);
      });
      acts.appendChild(delBtn);
      row.appendChild(acts);
      box.appendChild(row);
    });

    if (!libs.length) {
      var empty = document.createElement("p");
      empty.className = "lib-empty";
      empty.textContent = "列表是空的。加一个资料库，或点下面「恢复默认资料库」。";
      box.appendChild(empty);
    }

    var restore = $("btn-lib-restore");
    if (restore) {
      var allDefault = DEFAULT_LIBS.every(function (d) {
        return libs.some(function (l) { return resolveUrl(l.url) === resolveUrl(d.url); });
      });
      restore.hidden = allDefault;
    }
  }

  function addLibrary(rawUrl) {
    var abs = resolveUrl(rawUrl);
    if (!abs) { toast("网址不合法"); return; }
    if (!/^https?:/i.test(abs)) { toast("只支持 http / https 网址"); return; }
    if (libs.some(function (l) { return resolveUrl(l.url) === abs; })) {
      toast("这个资料库已经添加过了");
      return;
    }
    var probe = { url: abs, name: abs };
    toast("正在校验索引…");
    fetchIndex(probe).then(function (idx) {
      libs.push({ url: abs, name: idx.name, builtin: false, state: "ok", data: idx, err: "" });
      saveLibs();
      renderManageList();
      renderLibTree();
      $("lib-add-url").value = "";
      toast("已添加资料库：" + idx.name);
      log("addLibrary: ok", abs, idx.name);
    }).catch(function (err) {
      logError("addLibrary failed:", abs, err);
      toast("添加失败：" + err.message);
    });
  }

  /* ---------- 音色/语速弹层 ---------- */
  function togglePopover() {
    var pop = $("voice-pop");
    if (!pop) return;
    pop.hidden = !pop.hidden;
    $("btn-voice").setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) {
      populateVoices();
      renderRate();
    }
  }

  function closePopover() {
    var pop = $("voice-pop");
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    $("btn-voice").setAttribute("aria-expanded", "false");
  }

  /* ---------- 载入面板 ---------- */
  function openPanel() {
    if (!$("lib-modal").hidden) panelFromBrowse = true;
    $("panel").hidden = false;
    syncScrollLock();
  }

  function closePanel() {
    $("panel").hidden = true;
    syncScrollLock();
    if (panelFromBrowse) {
      panelFromBrowse = false;
      $("lib-modal").hidden = false;
      syncScrollLock();
      renderLibTree();
    }
  }

  function copyText(text, label) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? label + "已复制" : "复制失败，请手动选中复制");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(label + "已复制");
      }, fallback);
    } else {
      fallback();
    }
  }

  /* ---------- 提示 ---------- */
  function toast(msg) {
    var el = $("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("data-u32-name", "toast");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2800);
  }

  /* ---------- 进度记忆 ---------- */
  function persist() {
    try {
      var saved = {
        idx: state.idx, showZh: state.showZh, auto: state.auto, mask: state.mask,
        voiceURI: state.voiceURI, rate: state.rate
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
      log("persist: saved", saved);
    } catch (e) { logError("persist failed:", e); }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) { log("restore: no saved state"); return; }
      var v = JSON.parse(raw);
      if (v && typeof v.idx === "number") state.idx = v.idx;
      state.showZh = !!(v && v.showZh);
      state.auto = !!(v && v.auto);
      state.mask = !!(v && v.mask);
      if (v && typeof v.voiceURI === "string") state.voiceURI = v.voiceURI;
      if (v && typeof v.rate === "number") {
        state.rate = Math.min(2, Math.max(0.5, Math.round(v.rate * 10) / 10));
      }
      log("restore: loaded", {
        idx: state.idx, showZh: state.showZh, auto: state.auto,
        mask: state.mask, voiceURI: state.voiceURI, rate: state.rate
      });
    } catch (e) { logError("restore failed:", e); }
  }

  /* ---------- 装配 ---------- */
  function init() {
    log("init: start", document.readyState, location.href);
    loadLibs();
    try {
      state.data = normalize(window.DEMO_DATA);
    } catch (err) {
      logError("demo data invalid:", err);
      $("sentence").textContent = "示例数据异常：" + err.message;
      return;
    }

    restore();
    if (state.idx >= state.data.sentences.length) state.idx = 0;

    if ("speechSynthesis" in window) {
      populateVoices();
      populateVoices();
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
    renderRate();

    $("prompt-text").textContent = PROMPT;
    $("sample-text").textContent = SAMPLE;
    $("btn-zh").classList.toggle("active", state.showZh);
    $("btn-auto").classList.toggle("active", state.auto);
    render();

    /* ?src= 载入同源 JSON；demo 数据先渲染作兜底 */
    var srcParam = new URLSearchParams(location.search).get("src");
    if (srcParam) {
      log("src: requested", srcParam);
      var srcUrl = null;
      try {
        srcUrl = new URL(srcParam, location.href);
      } catch (err) {
        logError("src: invalid URL", srcParam, err);
        toast("src 参数不是合法 URL");
      }
      if (srcUrl && srcUrl.origin !== location.origin) {
        logError("src: cross-origin rejected", srcUrl.href, location.origin);
        toast("src 只允许同源 URL");
      } else if (srcUrl) {
        fetch(srcUrl.href).then(function (r) {
          log("src: fetch status", r.status, srcUrl.href);
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then(function (raw) {
          log("src: JSON parsed");
          state.data = normalize(raw);
          if (state.idx >= state.data.sentences.length) state.idx = 0;
          render();
          toast("已载入 URL 文章：" + state.data.title);
        }).catch(function (err) {
          logError("src load failed:", srcUrl && srcUrl.href, err);
          toast("URL 载入失败：" + err.message);
        });
      }
    }

    $("btn-zh").addEventListener("click", function () {
      log("toggle showZh:", state.showZh, "->", !state.showZh);
      state.showZh = !state.showZh;
      this.classList.toggle("active", state.showZh);
      render();
    });

    $("btn-mask").addEventListener("click", function () {
      log("toggle mask:", state.mask, "->", !state.mask);
      state.mask = !state.mask;
      render();
      toast(state.mask ? "遮挡已开启" : "遮挡已关闭");
    });

    $("btn-auto").addEventListener("click", function () {
      log("toggle auto:", state.auto, "->", !state.auto);
      state.auto = !state.auto;
      this.classList.toggle("active", state.auto);
      if (state.auto) speak(state.data.sentences[state.idx].en);
      persist();
    });

    $("btn-play").addEventListener("click", function () {
      speak(state.data.sentences[state.idx].en);
    });
    $("btn-prev").addEventListener("click", function () { go(-1); });
    $("btn-next").addEventListener("click", function () { go(1); });

    $("btn-load").addEventListener("click", openBrowse);

    /* ---------- 资料库事件 ---------- */
    $("btn-lib-import").addEventListener("click", openPanel);
    $("btn-lib-manage").addEventListener("click", openManage);
    $("btn-manage-close").addEventListener("click", closeManage);
    $("btn-lib-restore").addEventListener("click", restoreDefaultLib);
    $("lib-manage-modal").addEventListener("click", function (e) {
      if (e.target === this) closeManage();
    });
    $("lib-add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("lib-add-url").value.trim();
      if (!v) { toast("先填资料库网址"); return; }
      addLibrary(v);
    });
    $("btn-lib-close").addEventListener("click", closeBrowse);
    $("lib-modal").addEventListener("click", function (e) {
      if (e.target === this) closeBrowse();
    });
    $("btn-lib-load").addEventListener("click", loadSelectedArticle);
    $("lib-tree").addEventListener("scroll", function () {
      var t = this.scrollTop;
      var max = this.scrollHeight - this.clientHeight;
      /* 和回填目标一致 = 自己刚写进去的，忽略，别把旧位置冲掉 */
      if (desiredScroll !== null && Math.abs(t - desiredScroll) < 1) return;
      /* 折叠后内容变矮被浏览器钳位，不算用户滚动 */
      if (desiredScroll !== null && t < desiredScroll && desiredScroll > max) return;
      desiredScroll = t;
      if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(saveBrowseState, 150);
    });
    $("lib-filter").addEventListener("input", function () {
      libFilter = this.value;
      renderLibTree();
      if (libFilter.trim()) ensureAllIndexes().then(renderLibTree);
    });
    $("lib-filter").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (libSel) loadSelectedArticle();
      }
    });
    $("btn-voice").addEventListener("click", function (e) {
      e.stopPropagation();
      togglePopover();
    });
    $("sel-voice").addEventListener("change", function () {
      var key = this.value;
      var picked = allEnglishVoices().filter(function (v) {
        return (v.voiceURI || v.name) === key;
      })[0];
      if (!picked) { logError("sel-voice: selected voice not available:", key); return; }
      log("sel-voice: change", state.voiceURI || "(none)", "->", picked.name, picked.lang);
      voice = picked;
      state.voiceURI = key;
      resetVoiceRetry();
      persist();
      toast("已切换音色：" + picked.name);
    });
    $("range-rate").addEventListener("input", function () {
      var val = parseFloat(this.value);
      if (!isFinite(val)) { logError("range-rate: invalid value", this.value); return; }
      log("range-rate: change", state.rate, "->", val);
      state.rate = val;
      renderRate();
      persist();
    });
    $("btn-preview").addEventListener("click", function () {
      speak(state.data.sentences[state.idx].en);
    });
    $("btn-pick-file").addEventListener("click", function () { $("file").click(); });
    $("file").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (f) fillFromFile(f);
    });

    $("btn-panel-close").addEventListener("click", closePanel);
    $("panel").addEventListener("click", function (e) {
      if (e.target === this) closePanel();
    });
    $("btn-copy-prompt").addEventListener("click", function () {
      copyText(PROMPT, "提示词");
    });
    $("btn-copy-sample").addEventListener("click", function () {
      copyText(SAMPLE, "示例 JSON");
    });
    $("btn-paste-load").addEventListener("click", loadPasted);

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".wordcard") && !e.target.closest(".w")) closeCard();
      if (!e.target.closest(".setting-wrap")) closePopover();
    });

    document.addEventListener("keydown", function (e) {
      log("keydown:", e.key, "repeat", e.repeat,
        "target", e.target ? e.target.tagName + "." + (e.target.className || "") : "(none)");
      if (e.key === "Escape") {
        if (!$("lib-manage-modal").hidden) { log("keydown: Escape closes manage modal"); closeManage(); return; }
        if (!$("panel").hidden) { log("keydown: Escape closes panel"); closePanel(); return; }
        if (!$("lib-modal").hidden) { log("keydown: Escape closes browse modal"); closeBrowse(); return; }
        if (!$("voice-pop").hidden) { log("keydown: Escape closes popover"); closePopover(); return; }
        closeCard();
        return;
      }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
        log("keydown: ignored, input/select/textarea focused");
        return;
      }
      if (!$("panel").hidden || !$("lib-modal").hidden || !$("lib-manage-modal").hidden) {
        log("keydown: ignored, modal open"); return;
      }
      var isRateKey = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (!$("voice-pop").hidden && !isRateKey) {
        log("keydown: ignored, popover open and not rate key");
        return;
      }
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (isRateKey) {
        e.preventDefault();
        if (e.repeat) { log("keydown: ignored, repeat rate key"); return; }
        var delta = e.key === "ArrowUp" ? 0.1 : -0.1;
        var next = Math.min(2, Math.max(0.5, Math.round((state.rate + delta) * 10) / 10));
        var atLimit = next === state.rate;
        log("rate key:", e.key, state.rate, "->", next, atLimit ? "(limit)" : "");
        state.rate = next;
        renderRate();
        persist();
        toast("语速 " + state.rate.toFixed(1) + "×" +
          (atLimit ? (next === 2 ? "（最大）" : "（最小）") : ""));
      }
      else if (e.key === " ") {
        if (e.repeat) { log("keydown: ignored, repeat space"); return; }
        var t = e.target;
        if (t && t.closest && (t.closest(".w") || t.closest("button") || t.closest("a"))) {
          log("keydown: space handled by focused interactive element");
          return;
        }
        e.preventDefault();
        speak(state.data.sentences[state.idx].en);
      }
    });

    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    window.addEventListener("resize", closeCard);
    window.addEventListener("scroll", closeCard, true);
    window.addEventListener("wheel", handleWheel, { passive: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
