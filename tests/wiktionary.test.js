const assert = require('node:assert/strict');
const test = require('node:test');
const plugin = require('../main.js');

function wiki(title, english) {
  return { parse: { title, text: { '*': `<h2 id="English">English</h2>${english}<h2 id="French">French</h2><h3 id="Etymology">Etymology</h3><p>From faux + -ing.</p>` } } };
}

const embeddingEtym = wiki('Embedding', '<h3 id="Etymology">Etymology</h3><div class="etytree NavFrame"><div><p>Widget text must not appear.</p></div></div><p>From <i>embed</i> + <i>-ing</i>.</p>');
const embedEtym = wiki('embed', '<h3 id="Etymology">Etymology</h3><p>From <i>em-</i> + <i>bed</i>.</p>');
const exploreEtym = wiki('explore', '<h3 id="Etymology">Etymology</h3><p>From Middle French explorer, from Latin explōrāre, originally explained as ex- (“out”) + plōrāre (“to cry”), but the second element is also explained as “to make to flow”.</p>');
const mobile = '<h2 class="word"><span class="word">embedding</span></h2><div id="FCchild">埋入,埋藏</div><div id="FFchild"><div class="exp"><span class="cara">n.</span><ol><li>the act of embedding</li></ol></div></div>';

test('只读 English 词源正文，标题大小写可匹配，构词只取源明示的词干与词缀', () => {
  const embedding = plugin.parseWiktionary(JSON.stringify(embeddingEtym), 'embedding');
  const embed = plugin.parseWiktionary(embedEtym, 'embed');
  const explore = plugin.parseWiktionary(exploreEtym, 'explore');
  assert.equal(embedding.entries[0].text, 'From embed + -ing.');
  assert.deepEqual(embedding.entries[0].formation, { items: ['embed', '-ing'], stem: 'embed' });
  assert.deepEqual(embed.entries[0].formation, { items: ['em-', 'bed'], stem: 'bed' });
  assert.match(plugin.renderEtymology(embedding), /embed（词干） \+ -ing（后缀）/);
  assert.match(plugin.renderEtymology(embed), /em-（前缀） \+ bed（词干）/);
  assert.equal(explore.entries[0].formation, null);
  assert.match(plugin.renderEtymology(explore), /but the second element is also explained as/);
  assert.doesNotMatch(plugin.renderEtymology(explore), /构词：ex-/);
  assert.doesNotMatch(plugin.renderEtymology(embedding), /faux/);
  assert.doesNotMatch(plugin.renderEtymology(embedding), /Widget text/);
});

test('同组后续正文保留，出现限制或不同解释时不误判为无条件拆解', () => {
  const page = wiki('embedding', '<h3 id="Etymology">Etymology</h3>'
    + '<div class="etytree NavFrame"><p>Widget has a competing analysis.</p></div>'
    + '<p>From embed + -ing.</p><p>However, another analysis limits this formation.<sup class="reference">[1]</sup></p>');
  const parsed = plugin.parseWiktionary(page, 'embedding');
  assert.equal(parsed.entries[0].formation, null);
  assert.equal(parsed.entries[0].text, 'From embed + -ing.\n\nHowever, another analysis limits this formation.');
  const shown = plugin.renderEtymology(parsed);
  assert.match(shown, /From embed \+ -ing\.[\s\S]*However, another analysis/);
  assert.doesNotMatch(shown, /构词：|Widget has|\[1\]/);
});

test('多个英语词源按原章节分组，忽略其他语言的同名章节', () => {
  const page = wiki('test', '<h3 id="Etymology_1">Etymology 1</h3><p>From an- + apple.</p>'
    + '<h4 id="Noun">Noun</h4><p>This is a definition, not an etymology.</p>'
    + '<h3 id="Etymology_2">Etymology 2</h3><p>From another source.</p>'
    + '<h3 id="Etymology_3">Etymology 3</h3><p>Perhaps borrowed from elsewhere.</p>'
    + '<h3 id="Etymology_4">Etymology 4</h3><p>From one more source.</p>');
  const parsed = plugin.parseWiktionary(page, 'test');
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries.map((item) => item.id), ['Etymology_1', 'Etymology_2', 'Etymology_3']);
  assert.doesNotMatch(plugin.renderEtymology(parsed), /definition|faux/);
  assert.match(plugin.renderEtymology(parsed), /词源 1：/);
  assert.match(plugin.renderEtymology(parsed), /词源 2：/);
  assert.match(plugin.renderEtymology(parsed), /更多词源见来源/);
});

test('标题不匹配、无 English、无词源或 API error 均不给伪造拆解', () => {
  assert.equal(plugin.parseWiktionary(wiki('other', '<h3 id="Etymology"><p>From em- + bed.</p>'), 'embed'), null);
  assert.equal(plugin.parseWiktionary({ parse: { title: 'embed', text: { '*': '<h2 id="Latin">Latin</h2><h3 id="Etymology">Etymology</h3><p>From em- + bed.</p>' } } }, 'embed'), null);
  assert.equal(plugin.parseWiktionary(wiki('embed', '<h3 id="Noun">Noun</h3><p>bed</p>'), 'embed'), null);
  assert.equal(plugin.parseWiktionary({ error: { code: 'missingtitle' } }, 'embed'), null);
  assert.equal(plugin.renderEtymology(null), '**词根词缀**\n资料暂无。');
});

test('两次维基请求展示来源拆解，第二次失败仍保留主词与一次回调', () => {
  for (const secondaryFails of [false, true]) {
    const original = global.$http;
    const requests = [];
    const completions = [];
    global.$http = { request(value) { requests.push(value); } };
    try {
      const cancelSignal = {};
      plugin.translate({ text: 'embedding', cancelSignal, onCompletion(value) { completions.push(value); } });
      requests[0].handler({ response: { statusCode: 200 }, data: mobile });
      requests[1].handler({ error: { message: 'timeout' } });
      assert.match(requests[2].url, /page=embedding$/);
      assert.equal(requests[2].timeout, 5);
      assert.equal(requests[2].cancelSignal, cancelSignal);
      requests[2].handler({ response: { statusCode: 200 }, data: embeddingEtym });
      assert.equal(requests.length, 4);
      assert.match(requests[3].url, /page=embed$/);
      assert.equal(requests[3].timeout, 3);
      requests[3].handler(secondaryFails ? { error: { message: 'timeout' } } : { response: { statusCode: 200 }, data: JSON.stringify(embedEtym) });
      assert.equal(completions.length, 1);
      const result = completions[0].result;
      assert.deepEqual(result.toDict.parts, [{ part: '', means: ['埋入,埋藏'] }]);
      assert.match(result.content.text, /embed（词干） \+ -ing（后缀）/);
      assert.match(result.content.text, /英英释义/);
      if (secondaryFails) assert.doesNotMatch(result.content.text, /词干 embed：em-/);
      else assert.match(result.content.text, /词干 embed：em-（前缀） \+ bed（词干）/);
      requests[3].handler({ error: { message: 'late timeout' } });
      assert.equal(completions.length, 1);
    } finally {
      global.$http = original;
    }
  }
});

test('主词源网络失败、API error 和缺 English 时保留欧路内容且只回调一次', () => {
  const failures = [{ error: { message: 'offline' } }, { response: { statusCode: 200 }, data: { error: { code: 'missingtitle' } } },
    { response: { statusCode: 200 }, data: { parse: { title: 'embedding', text: { '*': '<h2 id="French">French</h2>' } } } }];
  for (const failure of failures) {
    const original = global.$http;
    const requests = [];
    const completions = [];
    global.$http = { request(value) { requests.push(value); } };
    try {
      plugin.translate({ text: 'embedding', onCompletion(value) { completions.push(value); } });
      requests[0].handler({ response: { statusCode: 200 }, data: mobile });
      requests[1].handler({ error: { message: 'offline' } });
      requests[2].handler(failure);
      assert.equal(requests.length, 3);
      assert.equal(completions.length, 1);
      assert.deepEqual(completions[0].result.toDict.parts, [{ part: '', means: ['埋入,埋藏'] }]);
      assert.match(completions[0].result.content.text, /英英释义[\s\S]*词根词缀\*\*\n资料暂无/);
    } finally {
      global.$http = original;
    }
  }
});
