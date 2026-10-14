const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const plugin = require('../main.js');

const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'info.json'), 'utf8'));
const examples = [1, 2, 3, 4, 5].map((number) => `<div class="lj_item" type="ting"><span class="channel_title">栏目 ${number}</span><p class="line">example ${number}</p><p class="exp">例句 ${number}</p></div>`).join('');
const page = `<h2 class="word"><span class="word">hello</span><span class="affiliate"><a data-rel="langid=en&txt=QYNaGVsbG8%3d"><uk>/hə'ləʊ/</uk><us>/hə'loʊ/</us></a></span></h2>
<div id="FCchild"><div class="exp"><ol><li>int. 喂；哈罗</li><li>n. 问候用语</li></ol></div><div id="trans"><span class="txtDisabled">时 态:</span><span class="trans">hellos</span></div></div>
<div id="FFchild"><div class="exp"><span class="cara">n.</span><ol><li>a greeting</li></ol></div></div>
<div id="SPECchild"><p id="phrase"><a>hello world</a><br>你好世界</p></div>
<div id="TingLijuchild">${examples}</div>`;

test('Bob 服务设置保留六个原生菜单并新增自动同步配置', () => {
  assert.equal(info.version, '0.8.1');
  assert.deepEqual(info.options.map((item) => item.identifier), [
    'pronunciation', 'showEnglish', 'showEtymology', 'showForms', 'showPhrases', 'exampleCount',
    'autoAdd', 'eudicAuthorization', 'wordbookId'
  ]);
  assert.deepEqual(info.options.map((item) => item.defaultValue), ['both', 'on', 'on', 'on', 'on', '4', 'off', '', '0']);
  for (const item of info.options.filter((item) => item.type === 'menu')) {
    assert.equal(item.type, 'menu');
    assert.ok(item.menuValues.some((value) => value.value === item.defaultValue));
    assert.ok(item.menuValues.every((value) => typeof value.title === 'string' && typeof value.value === 'string'));
  }
  assert.equal(info.options.find((item) => item.identifier === 'eudicAuthorization').textConfig.type, 'secure');
  assert.equal(info.options.find((item) => item.identifier === 'wordbookId').textConfig.type, 'visible');
});

test('默认内容、中文词性、音频与各设置的局部切换', () => {
  const normal = plugin.parseEntry(page, 'hello');
  assert.deepEqual(normal.toDict.phonetics.map((item) => item.type), ['us', 'uk']);
  assert.deepEqual(normal.toDict.parts, [
    { part: 'int.', means: ['喂；哈罗'] }, { part: 'n.', means: ['问候用语'] }
  ]);
  assert.deepEqual(normal.toDict.additions, [{ name: '时态', value: 'hellos' }]);
  assert.match(normal.content.text, /英英释义[\s\S]*词根词缀[\s\S]*词组[\s\S]*听力例句/);
  assert.equal(normal.raw.examples.length, 4);

  const noEnglish = plugin.parseEntry(page.replace('a greeting', '<img src="unknown.png">'), 'hello', { showEnglish: 'off' });
  assert.doesNotMatch(noEnglish.content.text, /英英释义|英英释义暂时无法完整显示/);
  assert.match(noEnglish.content.text, /词根词缀|词组/);
  const noPhrases = plugin.parseEntry(page.replace('你好世界', '<img src="unknown.png">'), 'hello', { showPhrases: 'off' });
  assert.doesNotMatch(noPhrases.content.text, /词组|你好世界/);
  assert.equal(noPhrases.raw.phrases.length, 0);
  const noForms = plugin.parseEntry(page, 'hello', { showForms: 'off' });
  assert.equal(noForms.toDict.additions, undefined);
  assert.deepEqual(noForms.toDict.parts, normal.toDict.parts);
  assert.doesNotMatch(noForms.content.text, /hellos|建议查找/);
  const noEtymology = plugin.parseEntry(page, 'hello', { showEtymology: 'off' });
  assert.doesNotMatch(noEtymology.content.text, /词根词缀|资料暂无/);
});

test('美音、英音、隐藏分别保留正确音频或移除音标，中文义项始终存在', () => {
  for (const [mode, types, voice] of [
    ['us', ['us'], 'en_us_female'], ['uk', ['uk'], 'en_uk_male'], ['none', [], null]
  ]) {
    const entry = plugin.parseEntry(page, 'hello', { pronunciation: mode });
    assert.deepEqual(entry.toDict.phonetics.map((item) => item.type), types);
    if (voice) assert.match(entry.toDict.phonetics[0].tts.value, new RegExp(voice));
    assert.equal(entry.toDict.parts.length, 2);
  }
});

test('例句 0、1、2、4 条分别控制解析和链接，全部辅助内容关闭时仅有原生中文卡片', () => {
  for (const [count, expected] of [['0', 0], ['1', 1], ['2', 2], ['4', 4]]) {
    const entry = plugin.parseEntry(page, 'hello', { exampleCount: count });
    assert.equal(entry.raw.examples.length, expected);
    if (expected === 0) assert.doesNotMatch(entry.content.text, /听力例句|在欧路听原声|更多例句/);
    else assert.match(entry.content.text, /在欧路听原声.*更多例句/);
  }
  const onlyChinese = plugin.parseEntry(page, 'hello', {
    pronunciation: 'none', showEnglish: 'off', showEtymology: 'off', showForms: 'off', showPhrases: 'off', exampleCount: '0'
  });
  assert.equal(onlyChinese.content, undefined);
  assert.deepEqual(onlyChinese.toDict.phonetics, []);
  assert.equal(onlyChinese.toDict.additions, undefined);
  assert.deepEqual(onlyChinese.toDict.parts, [
    { part: 'int.', means: ['喂；哈罗'] }, { part: 'n.', means: ['问候用语'] }
  ]);
});

test('缺值、空值和非法值恢复默认；数字字符串 0 不会回退为四条', () => {
  const defaults = plugin.parseEntry(page, 'hello');
  const invalid = plugin.parseEntry(page, 'hello', {
    pronunciation: '', showEnglish: 'invalid', showEtymology: null, showForms: '', showPhrases: 'yes', exampleCount: '3'
  });
  assert.deepEqual(invalid.toDict, defaults.toDict);
  assert.equal(invalid.content.text, defaults.content.text);
  assert.equal(invalid.raw.examples.length, 4);
  assert.equal(plugin.parseEntry(page, 'hello', { exampleCount: '0' }).raw.examples.length, 0);
});

test('翻译开始时只读一次设置快照，全部关闭只请求欧路核心且只回调一次', () => {
  const previousHttp = global.$http;
  const previousOption = global.$option;
  const requests = [];
  const completions = [];
  const reads = {};
  const option = {};
  const initial = {
    pronunciation: 'none', showEnglish: 'off', showEtymology: 'off', showForms: 'off', showPhrases: 'off', exampleCount: '0'
  };
  for (const [key, value] of Object.entries(initial)) {
    let current = value;
    Object.defineProperty(option, key, { enumerable: true, get() { reads[key] = (reads[key] || 0) + 1; return current; }, set(next) { current = next; } });
  }
  global.$http = { request(value) { requests.push(value); } };
  global.$option = option;
  try {
    plugin.translate({ text: 'hello', onCompletion(value) { completions.push(value); } });
    for (const key of Object.keys(initial)) option[key] = key === 'exampleCount' ? '4' : key === 'pronunciation' ? 'both' : 'on';
    requests[0].handler({ response: { statusCode: 200 }, data: page });
    assert.equal(requests.length, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].result.content, undefined);
    assert.deepEqual(completions[0].result.toDict.phonetics, []);
    assert.equal(completions[0].result.toDict.parts.length, 2);
    assert.deepEqual(reads, Object.fromEntries(Object.keys(initial).map((key) => [key, 1])));
  } finally {
    global.$http = previousHttp;
    global.$option = previousOption;
  }
});

test('关闭词形跳过桌面页，关闭词源跳过 Wiki；各自保留未关闭内容', () => {
  const previousHttp = global.$http;
  const previousOption = global.$option;
  try {
    for (const [settings, expectedUrl] of [
      [{ showForms: 'off', showEtymology: 'on' }, 'en.wiktionary.org'],
      [{ showForms: 'on', showEtymology: 'off' }, 'dict.eudic.net/dicts/en/hello']
    ]) {
      const requests = [];
      const completions = [];
      global.$option = settings;
      global.$http = { request(value) { requests.push(value); } };
      plugin.translate({ text: 'hello', onCompletion(value) { completions.push(value); } });
      requests[0].handler({ response: { statusCode: 200 }, data: page });
      assert.equal(requests.length, 2);
      assert.match(requests[1].url, new RegExp(expectedUrl));
      requests[1].handler({ error: { message: 'timeout' } });
      assert.equal(requests.length, 2);
      assert.equal(completions.length, 1);
      assert.equal(completions[0].result.toDict.parts.length, 2);
      if (settings.showEtymology === 'off') assert.doesNotMatch(completions[0].result.content.text, /词根词缀/);
      else assert.match(completions[0].result.content.text, /词根词缀/);
    }
  } finally {
    global.$http = previousHttp;
    global.$option = previousOption;
  }
});
