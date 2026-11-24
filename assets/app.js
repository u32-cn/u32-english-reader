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

  var state = { idx: 0, showZh: false, auto: false, data: null, voiceURI: "", rate: 1 };
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
    $("title").textContent = state.data.title;
    document.title = state.data.title + " · 轻读";
    $("sentence").innerHTML = tokenize(s.en, s.words);
    $("translation").textContent = s.zh || "";
    $("translation").hidden = !state.showZh || !s.zh;
    $("progress").textContent = (state.idx + 1) + " / " + state.data.sentences.length;
    bindWords();
    closeCard();
    if (state.auto) speak(s.en);
    persist();
  }

  function bindWords() {
    var nodes = $("sentence").querySelectorAll(".w");
    Array.prototype.forEach.call(nodes, function (el) {
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

  function pickVoice() {
    var vs = allEnglishVoices();
    if (!vs.length) return;
    if (state.voiceURI) {
      var saved = vs.filter(function (v) {
        return (v.voiceURI || v.name) === state.voiceURI;
      })[0];
      if (saved) { voice = saved; return; }
    }
    voice = vs.filter(function (v) { return /^en[-_]US/i.test(v.lang); })[0] ||
      vs.filter(function (v) { return /^en[-_]GB/i.test(v.lang); })[0] ||
      vs[0];
    state.voiceURI = voice.voiceURI || voice.name;
  }

  function populateVoices() {
    var sel = $("sel-voice");
    if (!sel) return;
    var vs = allEnglishVoices();
    sel.innerHTML = "";
    if (!vs.length) {
      var o = document.createElement("option");
      o.value = "";
      o.textContent = "系统暂无英语语音";
      sel.appendChild(o);
      sel.disabled = true;
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
  }

  function renderRate() {
    var el = $("rate-val");
    if (el) el.textContent = state.rate.toFixed(1) + "×";
    var range = $("range-rate");
    if (range) range.value = String(state.rate);
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持语音合成，请换用 Chrome / Edge");
      return;
    }
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
    u.onend = clearReading;
    u.onerror = clearReading;
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
    if (next < 0 || next >= state.data.sentences.length) return;
    state.idx = next;
    render();
  }

  /* ---------- 载入数据 ---------- */
  function applyData(obj, sourceLabel) {
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
    fr.onerror = function () { toast("文件读取失败"); };
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
        toast("载入失败：" + err.message);
        return;
      }
      applyData(parsed, file.name);
    };
    fr.onerror = function () { toast("文件读取失败"); };
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
      localStorage.setItem(STORE_KEY, JSON.stringify({
        idx: state.idx, showZh: state.showZh, auto: state.auto,
        voiceURI: state.voiceURI, rate: state.rate
      }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v && typeof v.idx === "number") state.idx = v.idx;
      state.showZh = !!(v && v.showZh);
      state.auto = !!(v && v.auto);
      if (v && typeof v.voiceURI === "string") state.voiceURI = v.voiceURI;
      if (v && typeof v.rate === "number") {
        state.rate = Math.min(2, Math.max(0.5, Math.round(v.rate * 10) / 10));
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 装配 ---------- */
  function init() {
    try {
      state.data = normalize(window.DEMO_DATA);
    } catch (err) {
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

    $("btn-zh").addEventListener("click", function () {
      state.showZh = !state.showZh;
      this.classList.toggle("active", state.showZh);
      render();
    });

    $("btn-auto").addEventListener("click", function () {
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
      if (!picked) return;
      voice = picked;
      state.voiceURI = key;
      persist();
      toast("已切换音色：" + picked.name);
    });
    $("range-rate").addEventListener("input", function () {
      var val = parseFloat(this.value);
      if (!isFinite(val)) return;
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
      if (e.key === "Escape") {
        if (!$("panel").hidden) { closePanel(); return; }
        if (!$("voice-pop").hidden) { closePopover(); return; }
        closeCard();
        return;
      }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === " ") { e.preventDefault(); speak(state.data.sentences[state.idx].en); }
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
