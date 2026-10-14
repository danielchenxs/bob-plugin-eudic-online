/* global $http, $option, $file, $data, $timer */

var DICTIONARY_URL = "https://dict.eudic.net/dicts/en/";
var MOBILE_URL = "https://dict.eudic.net/mdicts/en/";
var EXAMPLES_URL = "https://dict.eudic.net/liju/en/";
var SPEECH_URL = "https://api.frdic.com/api/v2/speech/speakweb?";
var WIKTIONARY_API = "https://en.wiktionary.org/w/api.php?action=parse&prop=text&format=json&redirects=1&page=";
var WIKTIONARY_PAGE = "https://en.wiktionary.org/wiki/";
var WORDBOOK_URL = "https://api.frdic.com/api/open/v1/studylist/words";
var CATEGORY_URL = "https://api.frdic.com/api/open/v1/studylist/category?language=en";
var PUBLIC_TTL = { mobile: 86400000, desktop: 86400000, wiki: 604800000 };
var PUBLIC_LIMIT = 200;
var PUBLIC_FILE_CHARS = 2000000;
var PUBLIC_FILE_BYTES = 2400000;
var CACHE_VERSION = 1;
var cacheMemory = {};
var ledgerMemory = null;
var blockedAccounts = null;
var rateMemory = null;
var pendingAdds = {};

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
    exampleCount: pick("exampleCount", ["0", "1", "2", "4"], "4"),
    autoAdd: pick("autoAdd", ["off", "on"], "off"),
    eudicAuthorization: typeof values.eudicAuthorization === "string" && !/[\r\n]/.test(values.eudicAuthorization)
      ? values.eudicAuthorization.trim() : "",
    wordbookId: typeof values.wordbookId === "string" ? values.wordbookId.trim() : "0"
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

function normalizeLookupWord(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function listedInflection(section, word) {
  var labels = { "时态": true, "复数": true, "比较级": true, "最高级": true,
    "过去式": true, "过去分词": true, "现在分词": true, "第三人称单数": true };
  var expected = normalizeLookupWord(word);
  var forms = parseForms(section);
  for (var i = 0; i < forms.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(labels, forms[i].name)) continue;
    var values = forms[i].value.split(/[,，;；]/);
    for (var j = 0; j < values.length; j++) {
      if (normalizeLookupWord(values[j]) === expected) return true;
    }
  }
  return false;
}

function entryIdentity(html, word) {
  if (!isLookup(word.trim().replace(/\s+/g, " "))) return null;
  var header = extractElement(html, "h2", "class", "word");
  var match = /<span\b[^>]*class="word"[^>]*>([^<]+)<\/span>/i.exec(header);
  var headword = match ? decodeEntities(match[1]).trim().replace(/\s+/g, " ") : "";
  if (!isLookup(headword)) return null;
  var section = extractElement(html, "div", "id", "FCchild");
  if (!section) return null;
  var alias = normalizeLookupWord(headword) !== normalizeLookupWord(word);
  if (alias && !listedInflection(section, word)) return null;
  return { headword: headword, section: section, alias: alias };
}

function isVerifiedBaseForm(html, candidate, word) {
  var identity = entryIdentity(html, candidate);
  return !!identity && !identity.alias && listedInflection(identity.section, word);
}

function desktopCacheIdentity(html, word) {
  var header = extractElement(html, "h1", "class", "explain-Word")
    || extractElement(html, "h2", "class", "word");
  if (header) {
    var span = extractElement(header, "span", "class", "word");
    var headword = htmlToPlainText(span || header).replace(/\s+/g, " ");
    return isLookup(headword) && normalizeLookupWord(headword) === normalizeLookupWord(word);
  }
  return !!parseSuggestion(html, word);
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
  var identity = entryIdentity(html, word);
  if (!identity) return null;
  var section = identity.section;
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
  if (identity.alias && options.showForms === "on") {
    if (!dict.additions) dict.additions = [];
    if (!dict.additions.some(function (item) { return item.name === "原形"; })) {
      dict.additions.push({ name: "原形", value: identity.headword });
    }
  }
  var content = renderContent(word, english, null, "", phrases, examples, examplesWarning, options);
  var result = {
    from: "en",
    to: "zh-Hans",
    toDict: dict,
    raw: { meaning: chinese.meaning, english: english, phrases: phrases, examples: examples,
      examplesWarning: examplesWarning, resolvedHeadword: identity.alias ? identity.headword : "" }
  };
  if (content) result.content = { format: "markdown", text: content };
  return result;
}

function isLookup(text) {
  return /^[A-Za-z][A-Za-z'’.-]*(?:[ -][A-Za-z][A-Za-z'’.-]*){0,5}$/.test(text) && text.length <= 80;
}

function storageAvailable() {
  return typeof $file !== "undefined" && typeof $data !== "undefined"
    && typeof $file.read === "function" && typeof $file.write === "function";
}

function readStore(path) {
  if (!storageAvailable()) return null;
  try {
    var data = $file.read(path);
    if (!data || typeof data.toUTF8 !== "function") return null;
    var text = data.toUTF8();
    return typeof text === "string" && text.length <= PUBLIC_FILE_CHARS
      && (typeof data.length !== "number" || data.length <= PUBLIC_FILE_BYTES) ? JSON.parse(text) : null;
  } catch (ignored) { return null; }
}

function writeStore(path, value) {
  if (!storageAvailable()) return;
  try { $file.write({ path: path, data: $data.fromUTF8(JSON.stringify(value)) }); }
  catch (ignored) { /* 缓存不可写时仍可查词 */ }
}

function validCacheValue(kind, value) {
  if (kind === "wiki") return !!value && typeof value === "object" && typeof value.title === "string"
    && value.title.length <= 80 && Array.isArray(value.entries) && value.entries.length <= 3
    && value.entries.every(function (entry) {
      return entry && typeof entry.id === "string" && typeof entry.text === "string"
        && entry.text.length <= 2000 && (!entry.formation || (Array.isArray(entry.formation.items)
          && entry.formation.items.length === 2 && entry.formation.items.every(function (item) { return typeof item === "string"; })
          && typeof entry.formation.stem === "string"));
    }) && (!value.secondary || (typeof value.secondary.title === "string"
      && typeof value.secondary.id === "string" && value.secondary.formation
      && Array.isArray(value.secondary.formation.items) && value.secondary.formation.items.length === 2));
  return typeof value === "string" && value.length > 0 && value.length <= 600000;
}

function utf8Length(text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function cacheBucket(kind) {
  if (!storageAvailable()) return null;
  if (cacheMemory[kind]) return cacheMemory[kind];
  var disk = readStore("$sandbox/eudic-public-" + kind + ".json");
  var entries = disk && disk.version === CACHE_VERSION && disk.entries && typeof disk.entries === "object"
    && !Array.isArray(disk.entries) ? disk.entries : {};
  var now = Date.now();
  var cleaned = Object.create(null);
  Object.keys(entries).slice(0, PUBLIC_LIMIT * 2).forEach(function (key) {
    var item = entries[key];
    if (item && typeof item.time === "number" && item.time <= now && now - item.time < PUBLIC_TTL[kind]
      && validCacheValue(kind, item.value)) cleaned[key] = item;
  });
  Object.keys(cleaned).sort(function (a, b) { return cleaned[b].time - cleaned[a].time; })
    .slice(PUBLIC_LIMIT).forEach(function (key) { delete cleaned[key]; });
  cacheMemory[kind] = cleaned;
  return cleaned;
}

function cacheGet(kind, word) {
  var bucket = cacheBucket(kind);
  var key = word.toLowerCase();
  var item = bucket && Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : null;
  if (!item) return null;
  if (Date.now() - item.time >= PUBLIC_TTL[kind]) { delete bucket[key]; return null; }
  if (kind === "wiki" && item.value.title.toLowerCase() !== key) { delete bucket[key]; return null; }
  if (kind === "desktop" && !desktopCacheIdentity(item.value, word)) { delete bucket[key]; return null; }
  if (kind === "mobile") {
    if (!entryIdentity(item.value, word)) { delete bucket[key]; return null; }
  }
  return item.value;
}

function cachePut(kind, word, value) {
  if (!validCacheValue(kind, value)) return;
  var bucket = cacheBucket(kind);
  if (!bucket) return;
  bucket[word.toLowerCase()] = { time: Date.now(), value: value };
  var keys = Object.keys(bucket).sort(function (a, b) { return bucket[b].time - bucket[a].time; });
  keys.slice(PUBLIC_LIMIT).forEach(function (key) { delete bucket[key]; });
  keys = keys.slice(0, PUBLIC_LIMIT);
  var serialized = JSON.stringify({ version: CACHE_VERSION, entries: bucket });
  var chars = serialized.length;
  var bytes = utf8Length(serialized);
  while (keys.length && (chars > PUBLIC_FILE_CHARS || bytes > PUBLIC_FILE_BYTES)) {
    var oldKey = keys.pop();
    var fragment = JSON.stringify(oldKey) + ":" + JSON.stringify(bucket[oldKey]);
    var comma = keys.length ? 1 : 0;
    chars -= fragment.length + comma;
    bytes -= utf8Length(fragment) + comma;
    delete bucket[oldKey];
  }
  serialized = JSON.stringify({ version: CACHE_VERSION, entries: bucket });
  while (keys.length && (serialized.length > PUBLIC_FILE_CHARS || utf8Length(serialized) > PUBLIC_FILE_BYTES)) {
    delete bucket[keys.pop()];
    serialized = JSON.stringify({ version: CACHE_VERSION, entries: bucket });
  }
  writeStore("$sandbox/eudic-public-" + kind + ".json", { version: CACHE_VERSION, entries: bucket });
}

function requestPublic(kind, word, timeout, cancelSignal, callback, isActive) {
  var saved = cacheGet(kind, word);
  if (saved) { callback(saved, true); return; }
  var url = kind === "mobile" ? MOBILE_URL + encodeURIComponent(word)
    : kind === "desktop" ? DICTIONARY_URL + encodeURIComponent(word)
      : WIKTIONARY_API + encodeURIComponent(word.toLowerCase());
  var once = false;
  function complete(value) { if (once) return; once = true; callback(value, false); }
  try { $http.request({
    method: "GET", url: url, header: { "Accept": kind === "wiki" ? "application/json" : "text/html" },
    timeout: timeout, cancelSignal: cancelSignal,
    handler: function (response) {
      if (once || (isActive && !isActive())) return;
      var value = null;
      if (response && !response.error && response.response && response.response.statusCode === 200) {
        if (kind === "wiki") {
          try { value = parseWiktionary(response.data, word); } catch (ignored) { value = null; }
        } else if (typeof response.data === "string") value = response.data;
      }
      var cacheable = !!value;
      if (kind === "mobile" && value) {
        if (!entryIdentity(value, word)) cacheable = false;
      }
      if (kind === "desktop" && value && !desktopCacheIdentity(value, word)) cacheable = false;
      if (cacheable && kind !== "mobile") cachePut(kind, word, value);
      complete(value);
    }
  }); } catch (ignored) { complete(null); }
}

function loadWiktionary(word, cancelSignal, callback, isActive) {
  requestPublic("wiki", word, 5, cancelSignal, function (primary) {
    if (!primary) { callback(null); return; }
    primary = JSON.parse(JSON.stringify(primary));
    var formation = primary.entries.length === 1 && primary.entries[0].formation;
    var stem = formation && formation.stem;
    if (!stem || stem.toLowerCase() === word.toLowerCase()) { callback(primary); return; }
    requestPublic("wiki", stem, 3, cancelSignal, function (secondary) {
      if (secondary && secondary.entries.length === 1 && secondary.entries[0].formation) {
        primary.secondary = { title: secondary.title, id: secondary.entries[0].id, formation: secondary.entries[0].formation };
      }
      callback(primary);
    }, isActive);
  }, isActive);
}

function authorizationHash(authorization) {
  try { return require("crypto-js").SHA256(authorization).toString(); }
  catch (ignored) {
    try { return require("node:crypto").createHash("sha256").update(authorization).digest("hex"); }
    catch (ignoredAgain) { return ""; }
  }
}

function ledger() {
  if (ledgerMemory) return ledgerMemory;
  var disk = readStore("$sandbox/eudic-private-ledger.json");
  var now = Date.now();
  var entries = disk && disk.version === CACHE_VERSION && disk.entries && typeof disk.entries === "object"
    && !Array.isArray(disk.entries) ? disk.entries : {};
  ledgerMemory = {};
  Object.keys(entries).slice(0, 1000).forEach(function (key) {
    var time = entries[key];
    if (/^[a-f0-9]{64}\|[0-9]+\|[a-z][a-z'’ .-]{0,79}$/i.test(key)
      && typeof time === "number" && time <= now && now - time < 86400000) ledgerMemory[key] = time;
  });
  return ledgerMemory;
}

function rememberWord(key) {
  if (!key) return;
  var entries = ledger();
  entries[key] = Date.now();
  var keys = Object.keys(entries).sort(function (a, b) { return entries[b] - entries[a]; });
  keys.slice(500).forEach(function (item) { delete entries[item]; });
  writeStore("$sandbox/eudic-private-ledger.json", { version: CACHE_VERSION, entries: entries });
}

function wordbookConfig(options) {
  var auth = options.eudicAuthorization;
  var id = options.wordbookId;
  return auth && !/[\r\n]/.test(auth) && /^(0|[1-9][0-9]*)$/.test(id)
    && id.length <= 32 ? { authorization: auth, id: id, hash: authorizationHash(auth) } : null;
}

function rateState() {
  if (rateMemory) return rateMemory;
  var disk = readStore("$sandbox/eudic-private-rate.json");
  var source = disk && disk.version === CACHE_VERSION && disk.accounts
    && typeof disk.accounts === "object" && !Array.isArray(disk.accounts) ? disk.accounts : {};
  var now = Date.now();
  rateMemory = Object.create(null);
  Object.keys(source).slice(0, 20).forEach(function (hash) {
    var entry = source[hash];
    if (!/^[a-f0-9]{64}$/.test(hash) || !entry || !Array.isArray(entry.calls)) return;
    var calls = entry.calls.filter(function (time) {
      return typeof time === "number" && time <= now && now - time < 1800000;
    }).slice(-450);
    var until = typeof entry.until === "number" && entry.until > now && entry.until <= now + 3600000
      ? entry.until : 0;
    if (calls.length || until) rateMemory[hash] = { calls: calls, until: until };
  });
  return rateMemory;
}

function persistRate() {
  var state = rateState();
  var accounts = Object.create(null);
  Object.keys(state).filter(function (key) { return /^[a-f0-9]{64}$/.test(key); }).slice(0, 20)
    .forEach(function (key) { accounts[key] = state[key]; });
  writeStore("$sandbox/eudic-private-rate.json", { version: CACHE_VERSION, accounts: accounts });
}

function accountPermit(hash) {
  var now = Date.now();
  if (blockedAccounts === null) {
    var stored = readStore("$sandbox/eudic-private-blocks.json");
    blockedAccounts = {};
    if (stored && stored.version === CACHE_VERSION && Array.isArray(stored.hashes)) {
      stored.hashes.slice(0, 50).forEach(function (value) {
        if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) blockedAccounts[value] = true;
      });
    }
  }
  if (hash && blockedAccounts[hash]) return false;
  var state = rateState();
  var key = hash || "unhashed";
  var account = state[key];
  if (!account) {
    Object.keys(state).forEach(function (item) {
      var value = state[item];
      value.calls = value.calls.filter(function (time) { return time <= now && now - time < 1800000; });
      if (!value.calls.length && value.until <= now) delete state[item];
    });
    if (hash && Object.keys(state).filter(function (item) { return item !== "unhashed"; }).length >= 20) return false;
    account = { calls: [], until: 0 };
    state[key] = account;
  }
  account.calls = account.calls.filter(function (time) { return time <= now && now - time < 1800000; });
  if (account && account.until > now) return false;
  var minute = account.calls.filter(function (time) { return now - time < 60000; }).length;
  if (minute >= 25 || account.calls.length >= 450) return false;
  account.calls.push(now);
  if (hash) persistRate();
  return true;
}

function accountFailure(hash, status) {
  var state = rateState();
  var key = hash || "unhashed";
  var account = state[key] || { calls: [], until: 0 };
  var delay = status === 401 && !hash ? Infinity : status === 403 || status === 429 ? 3600000 : 60000;
  account.until = Date.now() + delay;
  state[key] = account;
  if (hash) persistRate();
  if (status === 401 && hash) {
    if (blockedAccounts === null) blockedAccounts = {};
    blockedAccounts[hash] = true;
    var hashes = Object.keys(blockedAccounts).slice(-50);
    writeStore("$sandbox/eudic-private-blocks.json", { version: CACHE_VERSION, hashes: hashes });
  }
}

function scheduleTimeout(seconds, handler) {
  if (typeof $timer === "undefined" || typeof $timer.schedule !== "function") return null;
  try { return $timer.schedule({ interval: seconds, repeats: false, handler: handler }); }
  catch (ignored) { return null; }
}

function invalidateTimeout(id) {
  if (typeof id === "number" && typeof $timer !== "undefined" && typeof $timer.invalidate === "function") {
    try { $timer.invalidate(id); } catch (ignored) { /* HTTP 自身超时仍有效 */ }
  }
}

function addToWordbook(word, options, cancelSignal, isActive, callback) {
  var config = wordbookConfig(options);
  if (!config) { callback("请填写欧路 API 授权信息和有效生词本 ID"); return null; }
  var key = config.hash ? config.hash + "|" + config.id + "|" + word.toLowerCase() : "";
  if (key && ledger()[key] && Date.now() - ledger()[key] < 86400000) {
    callback("近期已加入（本机记录）"); return null;
  }
  if (key && pendingAdds[key]) { callback("本词正在同步"); return null; }
  if (!accountPermit(config.hash)) { callback("同步暂缓，请稍后再试"); return null; }
  if (key) pendingAdds[key] = true;
  var settled = false;
  var timer = scheduleTimeout(3, function () {
    if (settled || !isActive()) return;
    accountFailure(config.hash, 0);
    complete("同步网络超时");
  });
  function complete(status) {
    if (settled) return;
    settled = true;
    if (key) delete pendingAdds[key];
    invalidateTimeout(timer);
    if (isActive()) callback(status);
  }
  try { $http.request({
    method: "POST", url: WORDBOOK_URL, timeout: 3, cancelSignal: cancelSignal,
    header: { "Authorization": config.authorization, "Content-Type": "application/json" },
    body: { language: "en", category_id: config.id, words: [word] },
    handler: function (response) {
      if (settled || !isActive()) return;
      var status = response && response.response && response.response.statusCode;
      if (!response.error && status === 201) {
        rememberWord(key);
        complete("已加入欧路生词本");
      } else {
        accountFailure(config.hash, status);
        complete(status === 401 ? "欧路授权失败" : status === 403 || status === 429
          ? "欧路同步受限，请稍后再试" : "欧路同步失败，请稍后再试");
      }
    }
  }); } catch (ignored) { if (isActive()) accountFailure(config.hash, 0); complete("欧路同步失败，请稍后再试"); }
  return function () { complete(""); };
}

function pluginValidate(completion) {
  var options = normalizeOptions(typeof $option === "undefined" ? null : $option);
  if (options.autoAdd !== "on") { completion({ result: true }); return; }
  var config = wordbookConfig(options);
  if (!config) { completion({ result: false, error: { type: "secretKey", message: "请填写欧路 API 授权信息和有效生词本 ID" } }); return; }
  if (!accountPermit(config.hash)) { completion({ result: false, error: { type: "api", message: "验证暂缓，请稍后再试" } }); return; }
  var settled = false;
  var timer = scheduleTimeout(5, function () { finish(false, "验证超时，请稍后再试"); });
  function finish(ok, message) {
    if (settled) return;
    settled = true;
    invalidateTimeout(timer);
    completion(ok ? { result: true } : { result: false, error: { type: "api", message: message } });
  }
  try { $http.request({
    method: "GET", url: CATEGORY_URL, timeout: 5, header: { "Authorization": config.authorization },
    handler: function (response) {
      if (settled) return;
      var status = response && response.response && response.response.statusCode;
      if (response.error || status !== 200) {
        accountFailure(config.hash, status);
        finish(false, status === 401 ? "欧路授权失败" : "欧路验证失败，请稍后再试");
        return;
      }
      try {
        var payload = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        var categories = payload && payload.data;
        var exists = Array.isArray(categories) && categories.some(function (item) { return item && String(item.id) === String(config.id); });
        finish(exists, "未找到所选生词本 ID");
      } catch (ignored) { finish(false, "欧路验证返回异常"); }
    }
  }); } catch (ignored) { finish(false, "欧路验证失败，请稍后再试"); }
}

function previewText(word, result, core, options) {
  var lines = ["**" + word.replace(/([*_`\[\]])/g, "\\$1") + "**"];
  var phonetics = result.toDict.phonetics;
  for (var i = 0; i < phonetics.length; i++) {
    if (phonetics[i].value) lines.push((phonetics[i].type === "us" ? "美" : "英") + " /" + phonetics[i].value + "/");
  }
  lines.push("**英汉释义**");
  for (var j = 0; j < result.toDict.parts.length; j++) {
    var part = result.toDict.parts[j];
    lines.push((part.part ? part.part + " " : "") + part.means.join("；"));
  }
  var body = renderContent(word, core.english, null, "", core.phrases, core.examples,
    core.examplesWarning, Object.assign({}, options, { showEtymology: "off" }));
  if (body) lines.push(body);
  return lines.join("\n\n");
}

function translate(query, completion) {
  var done = query && typeof query.onCompletion === "function" ? query.onCompletion : completion;
  if (typeof done !== "function") return;
  var options = normalizeOptions(typeof $option === "undefined" ? null : $option);
  var completed = false;
  var cancelled = false;
  var subscription = null;
  var cancelTasks = [];
  var signal = query && query.cancelSignal;
  function active() { return !completed && !cancelled; }
  function finish(value) {
    if (!active()) return;
    completed = true;
    if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    done(value);
  }
  if (signal && typeof signal.subscribe === "function") {
    try { subscription = signal.subscribe(function () {
      cancelled = true;
      cancelTasks.forEach(function (cancel) { cancel(); });
      cancelTasks = [];
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }); } catch (ignored) { /* HTTP cancelSignal remains available */ }
  }
  var word = query && typeof query.text === "string" ? query.text.trim().replace(/\s+/g, " ") : "";
  if (!isLookup(word)) {
    finish({ error: { type: "param", message: "请输入英文单词或简短词组" } });
    return;
  }
  if (!active()) return;
  requestPublic("mobile", word, 15, signal, function (html, fromCache) {
    if (!active()) return;
    if (!html) { finish({ error: { type: "network", message: "欧路词典连接失败或返回异常" } }); return; }
    var result;
    try { result = parseEntry(html, word, options); }
    catch (error) { finish({ error: { type: "api", message: error.message || "释义解析失败" } }); return; }
    if (!result) { finish({ error: { type: "notFound", message: "欧路词典未找到该词条" } }); return; }
    var core = result.raw;
    delete result.raw;
    if (query && typeof query.onStream === "function") {
      try { query.onStream({ from: "en", to: "zh-Hans", content: { format: "markdown", text: previewText(word, result, core, options) } }); }
      catch (ignored) { /* Bob 仍会收到最终结果 */ }
    }
    if (!active()) return;
    if (!fromCache) cachePut("mobile", word, html);
    var pending = 0;
    var started = false;
    var suggestion = "";
    var etymology = null;
    var syncStatus = "";
    function branch() {
      pending++;
      var called = false;
      return function () {
        if (called || !active()) return false;
        called = true;
        pending--;
        if (started && pending === 0) completeResult();
        return true;
      };
    }
    function completeResult() {
      if (!active()) return;
      var text = renderContent(word, core.english, etymology, suggestion,
        core.phrases, core.examples, core.examplesWarning, options);
      if (options.autoAdd === "on") text += (text ? "\n\n" : "") + "生词本：" + syncStatus;
      if (text) result.content = { format: "markdown", text: text };
      else delete result.content;
      finish({ result: result });
    }
    if (options.showForms === "on" && !core.resolvedHeadword) {
      var formsDone = branch();
      requestPublic("desktop", word, 5, signal, function (desktop) {
        if (!active()) return;
        try { suggestion = desktop ? parseSuggestion(desktop, word) : ""; }
        catch (ignored) { suggestion = ""; }
        if (!suggestion) { formsDone(); return; }
        requestPublic("mobile", suggestion, 3, signal, function (candidate, candidateFromCache) {
          if (!active()) return;
          var verified = false;
          try { verified = !!candidate && isVerifiedBaseForm(candidate, suggestion, word); }
          catch (ignored) { verified = false; }
          if (verified) {
            if (!candidateFromCache) cachePut("mobile", suggestion, candidate);
            if (!result.toDict.additions) result.toDict.additions = [];
            result.toDict.additions.push({ name: "原形", value: suggestion });
            suggestion = "";
          }
          formsDone();
        }, active);
      }, active);
    }
    if (options.showEtymology === "on") {
      var wikiDone = branch();
      loadWiktionary(word, signal, function (value) {
        if (!active()) return;
        etymology = value;
        wikiDone();
      }, active);
    }
    if (options.autoAdd === "on") {
      var syncDone = branch();
      var stopSync = addToWordbook(word, options, signal, active, function (value) {
        if (!active()) return;
        syncStatus = value;
        syncDone();
      });
      if (stopSync) {
        if (cancelled) stopSync();
        else cancelTasks.push(stopSync);
      }
    }
    started = true;
    if (pending === 0) completeResult();
  }, active);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { supportLanguages: supportLanguages, translate: translate, parseEntry: parseEntry,
    parsePhonetics: parsePhonetics, parseExamples: parseExamples, parsePhrases: parsePhrases,
    parseWiktionary: parseWiktionary, renderEtymology: renderEtymology,
    htmlToMarkdown: htmlToMarkdown, isLookup: isLookup, pluginValidate: pluginValidate,
    _resetForTests: function () { cacheMemory = {}; ledgerMemory = null; blockedAccounts = null;
      rateMemory = null; pendingAdds = {}; } };
}
