/* global $http, $option */

var DICTIONARY_URL = "https://dict.eudic.net/dicts/en/";
var MOBILE_URL = "https://dict.eudic.net/mdicts/en/";
var EXAMPLES_URL = "https://dict.eudic.net/liju/en/";
var SPEECH_URL = "https://api.frdic.com/api/v2/speech/speakweb?";
var WIKTIONARY_API = "https://en.wiktionary.org/w/api.php?action=parse&prop=text&format=json&redirects=1&page=";
var WIKTIONARY_PAGE = "https://en.wiktionary.org/wiki/";

function normalizeOptions(source) {
  var values = source && typeof source === "object" ? source : {};
  function pick(key, allowed, fallback) {
    var value = values[key];
    return typeof value === "string" && allowed.indexOf(value) !== -1 ? value : fallback;
  }
  return {
    pronunciation: pick("pronunciation", ["both", "us", "uk", "none"], "both"),
    showEnglish: pick("showEnglish", ["on", "off"], "on"),
    showEtymology: pick("showEtymology", ["on", "off"], "on"),
    showForms: pick("showForms", ["on", "off"], "on"),
    showPhrases: pick("showPhrases", ["on", "off"], "on"),
    exampleCount: pick("exampleCount", ["0", "1", "2", "4"], "4")
  };
}

function supportLanguages() {
  return ["auto", "en", "zh-Hans"];
}

function decodeEntities(value) {
  var entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, function (match, entity) {
    if (entity.charAt(0) === "#") {
      var radix = entity.charAt(1).toLowerCase() === "x" ? 16 : 10;
      var number = parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
      if (number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)) {
        if (number <= 0xffff) return String.fromCharCode(number);
        number -= 0x10000;
        return String.fromCharCode(0xd800 + (number >> 10), 0xdc00 + (number & 0x3ff));
      }
      return match;
    }
    return Object.prototype.hasOwnProperty.call(entities, entity.toLowerCase())
      ? entities[entity.toLowerCase()] : match;
  });
}

function getAttribute(tag, name) {
  var match = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decodeEntities(match[1] || match[2] || match[3] || "") : "";
}

function matchesAttribute(tag, attribute, value) {
  var actual = getAttribute(tag, attribute);
  return attribute === "class" ? (" " + actual + " ").indexOf(" " + value + " ") !== -1 : actual === value;
}

function extractElement(html, tagName, attribute, value) {
  var opening = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  var start;
  while ((start = opening.exec(html)) && attribute && !matchesAttribute(start[0], attribute, value)) { /* 查找匹配的节点 */ }
  if (!start) return "";
  var begin = start.index + start[0].length;
  var depth = 1;
  var tags = new RegExp('<\\/?' + tagName + '\\b[^>]*>', 'gi');
  tags.lastIndex = begin;
  var tag;
  while ((tag = tags.exec(html))) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(begin, tag.index);
  }
  return "";
}

function removeCompleteElement(html, tagName, attribute, value) {
  var opening = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  var start;
  while ((start = opening.exec(html)) && !matchesAttribute(start[0], attribute, value)) { /* 查找匹配的节点 */ }
  if (!start) return html;
  var depth = 1;
  var tags = new RegExp('<\\/?' + tagName + '\\b[^>]*>', 'gi');
  tags.lastIndex = start.index + start[0].length;
  var tag;
  while ((tag = tags.exec(html))) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(0, start.index) + html.slice(tags.lastIndex);
  }
  return html;
}

function extractElements(html, tagName, attribute, value, limit) {
  var opening = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  var blocks = [];
  var match;
  while (blocks.length < limit && (match = opening.exec(html))) {
    if (attribute && !matchesAttribute(match[0], attribute, value)) continue;
    var tail = html.slice(match.index);
    var inner = extractElement(tail, tagName, attribute, value);
    if (inner) blocks.push({ opening: match[0], inner: inner });
    opening.lastIndex = match.index + match[0].length + inner.length;
  }
  return blocks;
}

function isEudicImage(url) {
  return /^https:\/\/(?:dict\.eudic\.net|www\.frdic\.com)\/tmp\/wordimg\/[A-Za-z0-9@+=._-]+\.png(?:\?[A-Za-z0-9=&._-]+)?$/i.test(url);
}

function htmlToMarkdown(html, highlightKeys) {
  var tokens = html.match(/<[^>]*>|[^<]+/g) || [];
  var output = "";
  var spanStack = [];
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.charAt(0) !== "<") {
      output += decodeEntities(token).replace(/\\/g, "\\\\").replace(/([*_`\[\]])/g, "\\$1");
    } else if (/^<img\b/i.test(token) && /\bdictimgtoword\b/i.test(getAttribute(token, "class"))) {
      var image = getAttribute(token, "src");
      if (!isEudicImage(image)) throw new Error("释义字图片地址不受支持");
      output += "![字](" + image + ")";
    } else if (/^<img\b/i.test(token)) {
      throw new Error("释义包含未知图片，无法完整显示");
    } else if (/^<span\b/i.test(token)) {
      var isKey = !!highlightKeys && matchesAttribute(token, "class", "key");
      spanStack.push(isKey);
      if (isKey) output += "**";
    } else if (/^<\/span\b/i.test(token)) {
      if (spanStack.pop()) output += "**";
    } else if (/^<(?:br|\/li|\/p)\b/i.test(token)) {
      output += "\n";
    } else if (/^<li\b/i.test(token)) {
      output += output && !/\n$/.test(output) ? "\n• " : "• ";
    } else if (/^<\/(?:div|ol|ul)\b/i.test(token)) {
      output += "\n";
    }
  }
  return output.replace(/\*\*\*\*/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToPlainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:br|\/li|\/p|\/div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseForms(section) {
  var trans = extractElement(section, "div", "id", "trans");
  if (!trans) return [];
  var spans = extractElements(trans, "span", null, null, 30);
  var forms = [];
  var label = "";
  for (var i = 0; i < spans.length; i++) {
    if (matchesAttribute(spans[i].opening, "class", "txtDisabled")) {
      label = htmlToPlainText(spans[i].inner).replace(/[\s:：]/g, "");
    } else if (label && matchesAttribute(spans[i].opening, "class", "trans")) {
      var value = htmlToPlainText(spans[i].inner);
      if (value) forms.push({ name: label, value: value });
      label = "";
    }
  }
  return forms;
}

function chinesePart(text) {
  var match = /^(int|interj|n|vt|vi|v|adj|adv|prep|pron|conj|num|art|aux|abbr|phr|pl|sing)\.\s*/i.exec(text);
  var value = match ? text.slice(match[0].length).trim() : text;
  return { part: match ? match[1] + "." : "", means: [value] };
}

function parseChineseMeaning(section, showForms) {
  var definition = removeCompleteElement(section, "div", "id", "trans");
  var meaning = htmlToPlainText(definition);
  if (!meaning) return null;
  var items = extractElements(definition, "li", null, null, 100);
  var itemTexts = [];
  for (var i = 0; i < items.length; i++) itemTexts.push(htmlToPlainText(items[i].inner));
  var complete = itemTexts.length && itemTexts.join("").replace(/\s/g, "") === meaning.replace(/\s/g, "");
  var parts = [];
  if (complete) {
    for (var j = 0; j < itemTexts.length; j++) {
      if (itemTexts[j]) parts.push(chinesePart(itemTexts[j]));
    }
  }
  if (!parts.length || !complete) parts = [meaning.indexOf("\n") === -1 ? chinesePart(meaning) : { part: "", means: [meaning] }];
  return { meaning: meaning, parts: parts, additions: showForms ? parseForms(section) : [] };
}

function parsePhonetics(html) {
  var affiliate = extractElement(html, "span", "class", "affiliate");
  if (!affiliate) return [];
  var link = /<a\b[^>]*>/i.exec(affiliate);
  var rel = link ? getAttribute(link[0], "data-rel") : "";
  var speech = /^langid=en&txt=([A-Za-z0-9%+=]+)$/i.exec(rel);
  var uk = { type: "uk" };
  var us = { type: "us" };
  if (speech) {
    uk.tts = { type: "url", value: SPEECH_URL + "langid=en&voicename=en_uk_male&txt=" + speech[1] };
    us.tts = { type: "url", value: SPEECH_URL + "langid=en&voicename=en_us_female&txt=" + speech[1] };
  }
  var ukMatch = /<uk\b[^>]*>([^<]*)<\/uk>/i.exec(affiliate);
  var usMatch = /<us\b[^>]*>([^<]*)<\/us>/i.exec(affiliate);
  var enMatch = /<en\b[^>]*>([^<]*)<\/en>/i.exec(affiliate);
  var enValue = enMatch ? decodeEntities(enMatch[1]).trim().replace(/^\/+|\/+$/g, "") : "";
  if (ukMatch) uk.value = decodeEntities(ukMatch[1]).trim().replace(/^\/+|\/+$/g, "");
  if (usMatch) us.value = decodeEntities(usMatch[1]).trim().replace(/^\/+|\/+$/g, "");
  if (!uk.value && enValue) uk.value = enValue;
  if (!us.value && enValue) us.value = enValue;
  return [us, uk].filter(function (item) { return item.value || item.tts; });
}

function parseEnglishMeaning(html) {
  var marker = /<div\b[^>]*\bid\s*=\s*["']FFchild["'][^>]*>/i.test(html);
  if (!marker) return { meaning: "", warning: "" };
  var section = extractElement(html, "div", "id", "FFchild");
  if (!section) return { meaning: "", warning: "英英释义暂时无法完整显示。" };
  try {
    var formatted = section.replace(/<span\b[^>]*>[^<]*<\/span>/gi, function (span) {
      var opening = /<span\b[^>]*>/i.exec(span);
      return opening && matchesAttribute(opening[0], "class", "cara") ? span + "<br>" : span;
    }).replace(/<div\b[^>]*>/gi, function (opening) {
      return matchesAttribute(opening, "class", "eg") ? opening + "<br>例句：" : opening;
    });
    var meaning = htmlToMarkdown(formatted);
    return meaning ? { meaning: meaning, warning: "" }
      : { meaning: "", warning: "英英释义暂时无法完整显示。" };
  } catch (ignored) {
    return { meaning: "", warning: "英英释义暂时无法完整显示。" };
  }
}

function parseSuggestion(html, word) {
  var hint = extractElement(html, "div", "class", "spellHint");
  var match = /<a\b[^>]*>([^<]+)<\/a>/i.exec(hint);
  var suggested = match ? decodeEntities(match[1]).trim() : "";
  return suggested && suggested.toLowerCase() !== word.toLowerCase() && isLookup(suggested) ? suggested : "";
}

function isVerifiedBaseForm(html, candidate, word) {
  var header = extractElement(html, "h2", "class", "word");
  var headword = /<span\b[^>]*class="word"[^>]*>([^<]+)<\/span>/i.exec(header);
  if (!headword || decodeEntities(headword[1]).trim().toLowerCase() !== candidate.toLowerCase()) return false;
  var section = extractElement(html, "div", "id", "FCchild");
  var forms = parseForms(section);
  for (var i = 0; i < forms.length; i++) {
    if (forms[i].name !== "时态") continue;
    var words = forms[i].value.split(/[,，;；\s]+/);
    for (var j = 0; j < words.length; j++) {
      if (words[j].toLowerCase() === word.toLowerCase()) return true;
    }
  }
  return false;
}

function parsePhrases(html) {
  var section = extractElement(html, "div", "id", "SPECchild");
  var blocks = extractElements(section, "div", "id", "phrase", 6)
    .concat(extractElements(section, "p", "id", "phrase", 6));
  var phrases = [];
  for (var i = 0; i < blocks.length && phrases.length < 6; i++) {
    var inner = blocks[i].inner;
    var link = /<a\b[^>]*>([^<]+)<\/a>/i.exec(inner);
    if (!link) continue;
    var name = decodeEntities(link[1]).trim();
    if (!isLookup(name)) continue;
    var meaning = htmlToMarkdown(inner.replace(link[0], "")).trim();
    if (meaning) phrases.push({ word: name, meaning: meaning });
  }
  return phrases;
}

function parseExamples(html, limit) {
  var count = limit === undefined ? 4 : limit;
  if (count === 0) return [];
  var blocks = extractElements(html, "div", "class", "lj_item", 12);
  var examples = [];
  for (var i = 0; i < blocks.length && examples.length < count; i++) {
    if (getAttribute(blocks[i].opening, "type") !== "ting") continue;
    var inner = blocks[i].inner;
    var line = extractElement(inner, "p", "class", "line");
    var translation = extractElement(inner, "p", "class", "exp");
    var channel = extractElement(inner, "span", "class", "channel_title");
    if (!line || !translation) continue;
    examples.push({
      line: htmlToMarkdown(line, true),
      translation: htmlToMarkdown(translation, true),
      channel: channel ? htmlToMarkdown(channel) : "",
      title: getAttribute(blocks[i].opening, "media_title")
    });
  }
  return examples;
}

function parseSimpleFormation(text) {
  var match = /^From ([^\s+.,;()]+) \+ ([^\s+.,;()]+)\.$/i.exec(text);
  if (!match) return null;
  var items = [match[1], match[2]];
  var affixes = items.filter(function (item) { return /^-/.test(item) || /-$/.test(item); });
  if (affixes.length !== 1) return null;
  var stem = items[0] === affixes[0] ? items[1] : items[0];
  if (!isLookup(stem) || stem.indexOf("-") !== -1) return null;
  return { items: items, stem: stem };
}

function parseWiktionary(data, word) {
  var payload = typeof data === "string" ? JSON.parse(data) : data;
  if (!payload || !payload.parse || typeof payload.parse.title !== "string"
    || payload.parse.title.toLowerCase() !== word.toLowerCase()
    || !payload.parse.text || typeof payload.parse.text["*"] !== "string") return null;
  var html = payload.parse.text["*"];
  var headings = [];
  var pattern = /<h([2-6])\b[^>]*\bid\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  var heading;
  while ((heading = pattern.exec(html))) headings.push({ level: Number(heading[1]), id: heading[2] || heading[3], start: heading.index, end: pattern.lastIndex });
  var english = -1;
  for (var i = 0; i < headings.length; i++) if (headings[i].level === 2 && headings[i].id === "English") { english = i; break; }
  if (english === -1) return null;
  var boundary = html.length;
  for (var j = english + 1; j < headings.length; j++) if (headings[j].level === 2) { boundary = headings[j].start; break; }
  var entries = [];
  var moreEntries = false;
  for (var k = english + 1; k < headings.length && headings[k].start < boundary; k++) {
    var current = headings[k];
    if (!/^Etymology(?:_[1-9][0-9]*)?$/.test(current.id)) continue;
    var end = k + 1 < headings.length && headings[k + 1].start < boundary
      ? headings[k + 1].start : boundary;
    var section = html.slice(current.end, end);
    var cleaned;
    do {
      cleaned = section;
      section = removeCompleteElement(section, "div", "class", "etytree");
      section = removeCompleteElement(section, "div", "class", "NavFrame");
    } while (section !== cleaned);
    var paragraphs = [];
    var paragraphPattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    var paragraph;
    while ((paragraph = paragraphPattern.exec(section))) {
      var line = htmlToPlainText(paragraph[1].replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")).replace(/\s+/g, " ").trim();
      if (line) paragraphs.push(line);
    }
    var text = paragraphs.join("\n\n");
    if (!text) continue;
    if (text.length > 2000 || entries.length >= 3) { moreEntries = true; continue; }
    entries.push({ id: current.id, text: text, formation: parseSimpleFormation(text) });
  }
  return entries.length || moreEntries ? { title: payload.parse.title, entries: entries, moreEntries: moreEntries } : null;
}

function wiktionaryUrl(word, id) {
  return WIKTIONARY_PAGE + encodeURIComponent(word.replace(/ /g, "_")) + "#" + (id || "English");
}

function renderFormation(formation) {
  return formation.items.map(function (item) {
    return item + "（" + (/-$/.test(item) ? "前缀" : /^-/.test(item) ? "后缀" : "词干") + "）";
  }).join(" + ");
}

function renderEtymology(etymology) {
  if (!etymology) return "**词根词缀**\n资料暂无。";
  if (!etymology.entries.length) return "**词根词缀**\n词源正文较长，请查看"
    + "[维基词典来源（CC BY-SA）](" + wiktionaryUrl(etymology.title, "English") + ")。";
  var lines = ["**词根词缀**"];
  for (var i = 0; i < etymology.entries.length; i++) {
    var entry = etymology.entries[i];
    var label = etymology.entries.length > 1 ? "词源 " + (i + 1) + "：" : "";
    lines.push("- " + label + (entry.formation ? "构词：" + renderFormation(entry.formation)
      : "词源：" + entry.text.replace(/\n\n/g, "\n\n  ")));
  }
  if (etymology.secondary && etymology.secondary.formation) {
    lines.push("- 词干 " + etymology.secondary.title + "：" + renderFormation(etymology.secondary.formation)
      + "（[来源](" + wiktionaryUrl(etymology.secondary.title, etymology.secondary.id) + ")）");
  }
  if (etymology.moreEntries) lines.push("更多词源见来源。");
  lines.push("[来源：维基词典英语词源（CC BY-SA）](" + wiktionaryUrl(etymology.title, etymology.entries[0].id) + ")");
  return lines.join("\n");
}

function renderContent(word, english, etymology, suggestion, phrases, examples, examplesWarning, options) {
  var urlWord = encodeURIComponent(word);
  var sections = [];
  if (options.showEnglish === "on") {
    if (english.meaning) sections.push("**英英释义**\n" + english.meaning);
    if (english.warning) sections.push(english.warning);
  }
  if (options.showEtymology === "on") sections.push(renderEtymology(etymology));
  if (options.showForms === "on" && suggestion) sections.push("建议查找：[" + suggestion + "](" + DICTIONARY_URL + encodeURIComponent(suggestion) + ")");
  if (options.showPhrases === "on" && phrases.length) {
    var phraseLines = ["**词组**"];
    for (var i = 0; i < phrases.length; i++) {
      phraseLines.push("- [" + phrases[i].word + "](" + DICTIONARY_URL + encodeURIComponent(phrases[i].word) + ")：" + phrases[i].meaning);
    }
    sections.push(phraseLines.join("\n"));
  }
  if (options.exampleCount > 0 && examples.length) {
    var exampleLines = ["**听力例句**"];
    for (var j = 0; j < examples.length; j++) {
      var example = examples[j];
      exampleLines.push((j + 1) + ". " + example.line + "\n   " + example.translation
        + (example.channel ? "\n   来源：" + example.channel : ""));
    }
    sections.push(exampleLines.join("\n\n"));
  }
  if (options.exampleCount > 0) {
    if (examplesWarning) sections.push(examplesWarning);
    sections.push("[在欧路听原声](eudic://dict/" + urlWord + ") · [更多例句](" + EXAMPLES_URL + urlWord + ")");
  }
  return sections.join("\n\n");
}

function parseEntry(html, word, opts) {
  var options = normalizeOptions(opts);
  var header = extractElement(html, "h2", "class", "word");
  var headword = /<span\b[^>]*class="word"[^>]*>([^<]+)<\/span>/i.exec(header);
  if (!headword || decodeEntities(headword[1]).trim().toLowerCase() !== word.toLowerCase()) return null;
  var section = extractElement(html, "div", "id", "FCchild");
  if (!section) return null;
  if (/<img\b/i.test(section)) throw new Error("移动页释义含图片，无法保证文字完整");
  var chinese = parseChineseMeaning(section, options.showForms === "on");
  if (!chinese) return null;
  var english = options.showEnglish === "on" ? parseEnglishMeaning(html) : { meaning: "", warning: "" };
  var phrases = options.showPhrases === "on" ? parsePhrases(html) : [];
  if (options.showPhrases === "on") {
    var phraseSection = extractElement(html, "div", "id", "SPECchild");
    if (/<img\b/i.test(phraseSection)) throw new Error("移动页词组含图片，无法保证文字完整");
  }
  var examples = [];
  var examplesWarning = "";
  if (options.exampleCount > 0) {
    var listeningSection = extractElement(html, "div", "id", "TingLijuchild");
    if (listeningSection) {
      try { examples = parseExamples(listeningSection, options.exampleCount); }
      catch (ignored) { examplesWarning = "部分听力例句无法完整显示，已省略。"; }
    }
  }
  var phonetics = options.pronunciation === "none" ? [] : parsePhonetics(html).filter(function (item) {
    return options.pronunciation === "both" || item.type === options.pronunciation;
  });
  var dict = { word: word, phonetics: phonetics, parts: chinese.parts };
  if (chinese.additions.length) dict.additions = chinese.additions;
  var content = renderContent(word, english, null, "", phrases, examples, examplesWarning, options);
  var result = {
    from: "en",
    to: "zh-Hans",
    toDict: dict,
    raw: { meaning: chinese.meaning, english: english, phrases: phrases, examples: examples, examplesWarning: examplesWarning }
  };
  if (content) result.content = { format: "markdown", text: content };
  return result;
}

function isLookup(text) {
  return /^[A-Za-z][A-Za-z'’.-]*(?:[ -][A-Za-z][A-Za-z'’.-]*){0,5}$/.test(text) && text.length <= 80;
}

function loadWiktionary(word, cancelSignal, callback) {
  function request(page, timeout, complete) {
    try { $http.request({
      method: "GET",
      url: WIKTIONARY_API + encodeURIComponent(page.toLowerCase()),
      header: { "Accept": "application/json" },
      timeout: timeout,
      cancelSignal: cancelSignal,
      handler: function (response) {
        var parsed = null;
        if (!response.error && response.response && response.response.statusCode === 200) {
          try { parsed = parseWiktionary(response.data, page); } catch (ignored) { parsed = null; }
        }
        complete(parsed);
      }
    }); } catch (ignored) { complete(null); }
  }
  request(word, 5, function (primary) {
    if (!primary) { callback(null); return; }
    var formation = primary.entries.length === 1 && primary.entries[0].formation;
    var stem = formation && formation.stem;
    if (!stem || stem.toLowerCase() === word.toLowerCase()) { callback(primary); return; }
    request(stem, 3, function (secondary) {
      if (secondary && secondary.entries.length === 1 && secondary.entries[0].formation) {
        primary.secondary = { title: secondary.title, id: secondary.entries[0].id, formation: secondary.entries[0].formation };
      }
      callback(primary);
    });
  });
}

function translate(query, completion) {
  var done = query && typeof query.onCompletion === "function" ? query.onCompletion : completion;
  if (typeof done !== "function") return;
  var options = normalizeOptions(typeof $option === "undefined" ? null : $option);
  var completed = false;
  function finish(value) {
    if (completed) return;
    completed = true;
    done(value);
  }
  var word = query && typeof query.text === "string" ? query.text.trim().replace(/\s+/g, " ") : "";
  if (!isLookup(word)) {
    finish({ error: { type: "param", message: "请输入英文单词或简短词组" } });
    return;
  }
  try { $http.request({
    method: "GET",
    url: MOBILE_URL + encodeURIComponent(word),
    header: { "Accept": "text/html" },
    timeout: 15,
    cancelSignal: query.cancelSignal,
    handler: function (response) {
      if (response.error) {
        finish({ error: { type: "network", message: "欧路词典连接失败：" + (response.error.message || "网络错误") } });
        return;
      }
      if (!response.response || response.response.statusCode !== 200 || typeof response.data !== "string") {
        finish({ error: { type: "network", message: "欧路词典返回异常" } });
        return;
      }
      try {
        var result = parseEntry(response.data, word, options);
        if (!result) {
          finish({ error: { type: "notFound", message: "欧路词典未找到该词条" } });
          return;
        }
        var core = result.raw;
        delete result.raw;
        function completeResult(suggestion) {
          function renderAndFinish(etymology) {
            var text = renderContent(word, core.english, etymology, suggestion,
              core.phrases, core.examples, core.examplesWarning, options);
            if (text) result.content = { format: "markdown", text: text };
            else delete result.content;
            finish({ result: result });
          }
          if (options.showEtymology === "on") loadWiktionary(word, query.cancelSignal, renderAndFinish);
          else renderAndFinish(null);
        }
        if (options.showForms === "off") { completeResult(""); return; }
        try { $http.request({
          method: "GET",
          url: DICTIONARY_URL + encodeURIComponent(word),
          header: { "Accept": "text/html" },
          timeout: 5,
          cancelSignal: query.cancelSignal,
          handler: function (desktopResponse) {
            var suggestion = "";
            if (!desktopResponse.error && desktopResponse.response
              && desktopResponse.response.statusCode === 200 && typeof desktopResponse.data === "string") {
              try { suggestion = parseSuggestion(desktopResponse.data, word); } catch (ignored) { suggestion = ""; }
            }
            if (!suggestion) { completeResult(""); return; }
            function finishSuggestion(verified) {
              if (verified) {
                if (!result.toDict.additions) result.toDict.additions = [];
                result.toDict.additions.push({ name: "原形", value: suggestion });
              }
              completeResult(verified ? "" : suggestion);
            }
            try { $http.request({
              method: "GET",
              url: MOBILE_URL + encodeURIComponent(suggestion),
              header: { "Accept": "text/html" },
              timeout: 3,
              cancelSignal: query.cancelSignal,
              handler: function (candidateResponse) {
                var verified = false;
                if (!candidateResponse.error && candidateResponse.response
                  && candidateResponse.response.statusCode === 200 && typeof candidateResponse.data === "string") {
                  try { verified = isVerifiedBaseForm(candidateResponse.data, suggestion, word); }
                  catch (ignored) { verified = false; }
                }
                finishSuggestion(verified);
              }
            }); } catch (ignored) { finishSuggestion(false); }
          }
        }); } catch (ignored) { completeResult(""); }
      } catch (error) {
        finish({ error: { type: "api", message: error.message || "释义解析失败" } });
      }
    }
  }); } catch (error) {
    finish({ error: { type: "network", message: "欧路词典连接失败：" + (error.message || "网络错误") } });
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { supportLanguages: supportLanguages, translate: translate, parseEntry: parseEntry,
    parsePhonetics: parsePhonetics, parseExamples: parseExamples, parsePhrases: parsePhrases,
    parseWiktionary: parseWiktionary, renderEtymology: renderEtymology,
    htmlToMarkdown: htmlToMarkdown, isLookup: isLookup };
}
