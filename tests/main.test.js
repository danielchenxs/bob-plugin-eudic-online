const assert = require('node:assert/strict');
const test = require('node:test');
const plugin = require('../main.js');

function listeningItem(number, extraClass = '') {
  return `<div class="lj_item" type="ting" media_title="节目 ${number}"><div class="channel"><span class="channel_title">栏目 ${number}</span></div><div class="content"><p class="line">This is <span class="key">embedding</span> ${number}.</p><p class="exp${extraClass}">这是<span class="key">嵌入</span> ${number}。</p></div></div>`;
}

const embedding = `<section class="mobileDictContent"><h2 class="word"><span class="word">embedding</span><span class="affiliate"><a class="voice-js" data-rel="langid=en&txt=QYNZW1iZWRkaW5n"><en>/ɪm'bɛd/</en></a></span></h2>
<div id="FCchild" class="expDiv">埋入,埋藏</div>
<div id="SPECchild" class="expDiv"><p id="phrase"><a href="/dicts/en/embedding%20medium">embedding medium</a><br>包埋剂</p><p id="phrase"><a href="/dicts/en/paraffin%20embedding">paraffin embedding</a><br>石蜡加填充剂</p></div>
<div id="TingLijuchild" class="expDiv">${[1, 2, 3, 4, 5].map((n) => listeningItem(n, n === 1 ? ' mt' : '')).join('')}</div></section>`;

const hello = `<h2 class="word"><span class="word">hello</span><span class="affiliate"><a class="voice-js" data-rel="langid=en&txt=QYNaGVsbG8%3d"><uk>/hə'ləʊ/</uk><us>/hə'loʊ/</us></a></span></h2><div id="FCchild" class="expDiv"><ol><li>int. 喂；哈罗</li><li>n. 表示问候的用语</li></ol></div>`;

const embeddingEnglish = `<div id="FFchild" class="expDiv"><!--word-thumbnail-image--><div class="exp"><span class="cara">n.</span><ol><li>The act or process by which one thing is embedded in another.</li><li>A representation of a unit of text (such as a word or token) as a vector, which encodes the context in which it is used.</li><div class="eg"><ul><li>word embeddings</li></ul></div></ol></div></div>`;
const helloEnglish = `<div id="FFchild" class="expDiv"><!--word-thumbnail-image--><div class="exp"><span class="cara">n.</span><ol><li>an expression of greeting</li><div class="eg"><ul><li>every morning they exchanged polite hellos</li></ul></div><br /><i>synonymous：</i> <a href="/dicts/en/hullo">hullo</a>, <a href="/dicts/en/hi">hi</a>, <a href="/dicts/en/howdy">howdy</a></ol></div></div>`;
const explore = `<h2 class="word"><span class="word">explore</span></h2><div id="FCchild" class="expDiv"><div class="exp"><ol><li>vt. 探测；探索；探险</li><li>vi. 探测；探险；探索</li></ol></div><div id="trans"><span class="txtDisabled">时 态: </span><span class="trans">explored, exploring, explores</span><br></div></div>`;
const embed = `<h2 class="word"><span class="word">embed</span></h2><div id="FCchild" class="expDiv"><div class="exp">vt. 栽种；使嵌入，使插入；使深留脑中</div><div id="trans"><span class="txtDisabled">时 态: </span><span class="trans">embedded, embedding, embeds</span><br><span class="txtDisabled">名 词: </span><span class="trans">embedment</span><br></div></div>`;

test('移动页 embedding 完整纯文本、词组、四条听力例句与本词音频', () => {
  const entry = plugin.parseEntry(embedding, 'embedding');
  assert.deepEqual(entry.toDict.parts, [{ part: '', means: ['埋入,埋藏'] }]);
  assert.doesNotMatch(entry.content.text, /埋入,埋藏|英汉释义/);
  assert.match(entry.content.text, /embedding medium.*包埋剂/);
  assert.equal((entry.content.text.match(/来源：栏目/g) || []).length, 4);
  assert.match(entry.content.text, /This is \*\*embedding\*\* 1/);
  assert.match(entry.content.text, /在欧路听原声\]\(eudic:\/\/dict\/embedding\)/);
  assert.doesNotMatch(entry.content.text, /!\[字\]|ɪm'bɛd/);
  assert.deepEqual(entry.toDict.phonetics.map((item) => item.type), ['us', 'uk']);
  assert.deepEqual(entry.toDict.phonetics.map((item) => item.value), ["ɪm'bɛd", "ɪm'bɛd"]);
  assert.ok(entry.toDict.phonetics.every((item) => item.tts.value.includes('txt=QYNZW1iZWRkaW5n')));
  assert.equal(entry.toDict.additions, undefined);
});

test('明确 uk/us 标签的 hello 保留各自音标', () => {
  const entry = plugin.parseEntry(hello, 'hello');
  assert.deepEqual(entry.toDict.phonetics.map((item) => item.value), ["hə'loʊ", "hə'ləʊ"]);
  assert.match(entry.toDict.phonetics[0].tts.value, /voicename=en_us_female/);
  assert.match(entry.toDict.phonetics[1].tts.value, /voicename=en_uk_male/);
});

test('通用音标只补缺失的地区音标', () => {
  const mixed = hello.replace('<us>/hə\'loʊ/</us>', '<en>/generic/</en>');
  const entry = plugin.parseEntry(mixed, 'hello');
  assert.deepEqual(entry.toDict.phonetics.map((item) => item.value), ['generic', "hə'ləʊ"]);
});

test('真实移动页结构展示英英词性、定义、例句和近义词', () => {
  const entry = plugin.parseEntry(hello + helloEnglish, 'hello');
  assert.deepEqual(entry.toDict.parts, [
    { part: 'int.', means: ['喂；哈罗'] },
    { part: 'n.', means: ['表示问候的用语'] }
  ]);
  assert.doesNotMatch(entry.content.text, /喂；哈罗|表示问候的用语|英汉释义/);
  assert.match(entry.content.text, /\*\*英英释义\*\*\nn\.\n• an expression of greeting/);
  assert.match(entry.content.text, /例句：\n• every morning they exchanged polite hellos/);
  assert.match(entry.content.text, /synonymous： hullo, hi, howdy/);
  assert.ok(entry.content.text.startsWith('**英英释义**'));
  const embeddingEntry = plugin.parseEntry(embedding + embeddingEnglish, 'embedding');
  assert.match(embeddingEntry.content.text, /A representation of a unit of text.*as a vector/);
  assert.match(embeddingEntry.content.text, /word embeddings/);
  assert.ok(embeddingEntry.content.text.indexOf('**英英释义**') < embeddingEntry.content.text.indexOf('**词组**'));
});

test('英英部分缺失或无法完整解析时，保留英汉核心释义', () => {
  assert.doesNotMatch(plugin.parseEntry(hello, 'hello').content.text, /英英释义/);
  const broken = plugin.parseEntry(hello + helloEnglish.replace('an expression of greeting', '<img src="unknown.png">'), 'hello');
  assert.deepEqual(broken.toDict.parts[0], { part: 'int.', means: ['喂；哈罗'] });
  assert.match(broken.content.text, /英英释义暂时无法完整显示/);
});

test('中文释义分词性，时态和名词按源分别记录且不带 Markdown 转义', () => {
  const entry = plugin.parseEntry(explore, 'explore');
  assert.deepEqual(entry.toDict.parts, [
    { part: 'vt.', means: ['探测；探索；探险'] },
    { part: 'vi.', means: ['探测；探险；探索'] }
  ]);
  assert.deepEqual(entry.toDict.additions, [{ name: '时态', value: 'explored, exploring, explores' }]);
  assert.doesNotMatch(entry.content.text, /探测|时态|英汉释义/);
  const base = plugin.parseEntry(embed, 'embed');
  assert.deepEqual(base.toDict.parts, [{ part: 'vt.', means: ['栽种；使嵌入，使插入；使深留脑中'] }]);
  assert.deepEqual(base.toDict.additions, [
    { name: '时态', value: 'embedded, embedding, embeds' },
    { name: '名词', value: 'embedment' }
  ]);
  const medical = plugin.parseEntry(hello.replace('int. 喂；哈罗', 'int. [医] 喂；哈罗'), 'hello');
  assert.equal(medical.toDict.parts[0].means[0], '[医] 喂；哈罗');
});

test('exp 后的中文补充释义仍保留，时态只进入附加内容', () => {
  const page = explore.replace('</ol></div><div id="trans">', '</ol></div><p>[医] 补充中文解释</p><div id="trans">');
  const entry = plugin.parseEntry(page, 'explore');
  const nativeText = entry.toDict.parts.flatMap((part) => part.means).join('\n');
  assert.match(nativeText, /探测；探索；探险/);
  assert.match(nativeText, /探测；探险；探索/);
  assert.match(nativeText, /\[医\] 补充中文解释/);
  assert.doesNotMatch(nativeText, /explored|exploring|explores|时态/);
  assert.deepEqual(entry.toDict.additions, [{ name: '时态', value: 'explored, exploring, explores' }]);
});

test('没有 exp 的词条单独提取中文释义和时态', () => {
  const page = embed.replace('<div class="exp">vt. 栽种；使嵌入，使插入；使深留脑中</div>', 'vt. 栽种；使嵌入，使插入；使深留脑中');
  const entry = plugin.parseEntry(page, 'embed');
  assert.deepEqual(entry.toDict.parts, [{ part: 'vt.', means: ['栽种；使嵌入，使插入；使深留脑中'] }]);
  assert.deepEqual(entry.toDict.additions, [
    { name: '时态', value: 'embedded, embedding, embeds' },
    { name: '名词', value: 'embedment' }
  ]);
});

test('不存在词或核心释义图片不会产生不完整结果', () => {
  assert.equal(plugin.parseEntry('<html></html>', 'missing'), null);
  assert.equal(plugin.parseEntry(embedding, 'another'), null);
  assert.throws(() => plugin.parseEntry(embedding.replace('埋入,埋藏', '埋入<img class="dictimgtoword" src="x.png">'), 'embedding'), /移动页释义含图片/);
});

test('听力例句含未知图片时给出可见提示', () => {
  const withImage = embedding.replace('这是<span class="key">嵌入</span> 1。', '这是<img src="https://example.com/unknown.png"> 1。');
  const entry = plugin.parseEntry(withImage, 'embedding');
  assert.match(entry.content.text, /部分听力例句无法完整显示，已省略/);
  assert.doesNotMatch(entry.content.text, /!\[字\]/);
});

test('相邻例句关键词合并加粗且保留原文星号', () => {
  assert.equal(plugin.htmlToMarkdown('觉得<span class="key">不</span><span class="key">快乐</span> *', true), '觉得**不快乐** \\*');
});

test('可选桌面基词提示失败时保留移动页核心结果', () => {
  const previous = global.$http;
  const requests = [];
  global.$http = { request(value) { requests.push(value); } };
  try {
    const received = [];
    plugin.translate({ text: 'embedding', onCompletion(value) { received.push(value); } });
    assert.equal(requests[0].url, 'https://dict.eudic.net/mdicts/en/embedding');
    requests[0].handler({ response: { statusCode: 200 }, data: embedding });
    assert.equal(requests[1].url, 'https://dict.eudic.net/dicts/en/embedding');
    assert.equal(requests[1].timeout, 5);
    requests[1].handler({ error: { message: 'timeout' } });
    assert.match(requests[2].url, /en\.wiktionary\.org\/w\/api\.php/);
    requests[2].handler({ error: { message: 'timeout' } });
    assert.equal(received.length, 1);
    assert.equal(received[0].result.toDict.parts[0].means[0], '埋入,埋藏');
    assert.equal(received[0].result.raw, undefined);
  } finally {
    global.$http = previous;
  }
});

test('桌面建议经原形词条时态验证后加入原形，英英与例句保留', () => {
  const previous = global.$http;
  const requests = [];
  global.$http = { request(value) { requests.push(value); } };
  try {
    let result;
    plugin.translate({ text: 'embedding', onCompletion(value) { result = value.result; } });
    requests[0].handler({ response: { statusCode: 200 }, data: embedding + embeddingEnglish });
    requests[1].handler({ response: { statusCode: 200 }, data: '<div class="spellHint">您是否要查找：<a href="/dicts/search/embed">embed</a></div>' });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, 'https://dict.eudic.net/mdicts/en/embed');
    assert.equal(requests[2].timeout, 3);
    requests[2].handler({ response: { statusCode: 200 }, data: embed });
    assert.match(requests[3].url, /en\.wiktionary\.org\/w\/api\.php/);
    requests[3].handler({ error: { message: 'timeout' } });
    assert.deepEqual(result.toDict.additions, [{ name: '原形', value: 'embed' }]);
    assert.doesNotMatch(result.content.text, /建议查找/);
    assert.deepEqual(result.toDict.parts, [{ part: '', means: ['埋入,埋藏'] }]);
    assert.match(result.content.text, /A representation of a unit of text.*as a vector/);
    assert.ok(result.content.text.startsWith('**英英释义**'));
    assert.equal((result.content.text.match(/来源：栏目/g) || []).length, 4);
  } finally {
    global.$http = previous;
  }
});

test('错误或未含查询词的候选不伪造原形，候选失败保留建议和英英', () => {
  for (const candidate of [embed.replace('embedding, ', ''), embed.replace('>embed</span>', '>wrong</span>'), null]) {
    const previous = global.$http;
    const requests = [];
    global.$http = { request(value) { requests.push(value); } };
    try {
      let result;
      plugin.translate({ text: 'embedding', onCompletion(value) { result = value.result; } });
      requests[0].handler({ response: { statusCode: 200 }, data: embedding + embeddingEnglish });
      requests[1].handler({ response: { statusCode: 200 }, data: '<div class="spellHint"><a>embed</a></div>' });
      requests[2].handler(candidate === null ? { error: { message: 'timeout' } } : { response: { statusCode: 200 }, data: candidate });
      requests[3].handler({ error: { message: 'timeout' } });
      assert.equal(result.toDict.additions, undefined);
      assert.match(result.content.text, /建议查找：\[embed\]/);
      assert.match(result.content.text, /A representation of a unit of text.*as a vector/);
    } finally {
      global.$http = previous;
    }
  }
});

test('核心网络错误与无结果分别回报', () => {
  const previous = global.$http;
  let request;
  global.$http = { request(value) { request = value; } };
  try {
    let received;
    plugin.translate({ text: 'hello', onCompletion(value) { received = value; } });
    request.handler({ error: { message: 'offline' } });
    assert.equal(received.error.type, 'network');
    plugin.translate({ text: 'hello', onCompletion(value) { received = value; } });
    request.handler({ response: { statusCode: 200 }, data: '<html></html>' });
    assert.equal(received.error.type, 'notFound');
  } finally {
    global.$http = previous;
  }
});
