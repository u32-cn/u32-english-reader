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
    document.title = state.data.title + " · 轻读";
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

  /* ---------- 载入数据 ---------- */
  function applyData(obj, sourceLabel) {
    log("applyData:", sourceLabel || "(none)", "title", obj.title, "sentences", obj.sentences.length);
    state.data = obj;
    state.idx = 0;
    render();
    toast("已载入「" + obj.title + "」，共 " + obj.sentences.length + " 句" + (sourceLabel ? "（" + sourceLabel + "）" : ""));
    closePanel();
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
    $("panel").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closePanel() {
    $("panel").hidden = true;
    document.body.style.overflow = "";
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

    $("btn-load").addEventListener("click", openPanel);
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
        if (!$("panel").hidden) { log("keydown: Escape closes panel"); closePanel(); return; }
        if (!$("voice-pop").hidden) { log("keydown: Escape closes popover"); closePopover(); return; }
        closeCard();
        return;
      }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
        log("keydown: ignored, input/select/textarea focused");
        return;
      }
      if (!$("panel").hidden) { log("keydown: ignored, panel open"); return; }
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
