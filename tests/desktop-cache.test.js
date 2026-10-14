const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const plugin = require(process.env.BOB_MAIN_UNDER_TEST || '../main.js');

const desktop = fs.readFileSync(path.join(__dirname, 'fixtures', 'elude-desktop.html'), 'utf8');
const mobile = '<h2 class="word"><span class="word">elude</span></h2><div id="FCchild">vt. 躲避；逃避</div>';

function environment() {
  plugin._resetForTests();
  const previous = Object.fromEntries(['$http', '$option', '$file', '$data'].map(key => [key, global[key]]));
  const disk = Object.create(null);
  const writes = [];
  const requests = [];
  global.$option = { showForms: 'on', showEtymology: 'off', autoAdd: 'off' };
  global.$http = { request(value) { requests.push(value); } };
  global.$data = { fromUTF8(text) { return { length: Buffer.byteLength(text), toUTF8: () => text }; } };
  global.$file = {
    read(name) { return disk[name] ? { length: Buffer.byteLength(disk[name]), toUTF8: () => disk[name] } : null; },
    write({ path: name, data }) { disk[name] = data.toUTF8(); writes.push(name); }
  };
  return { disk, writes, requests, restore() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  } };
}
function lookup() {
  const completed = [];
  plugin.translate({ text: 'elude', onCompletion(value) { completed.push(value); } });
  return completed;
}
function answer(request, html) { request.handler({ response: { statusCode: 200 }, data: html }); }

test('真实桌面 h1 词头缓存，重复和重建上下文均无需再次 GET 或刷新 TTL', () => {
  const env = environment();
  try {
    const first = lookup();
    answer(env.requests[0], mobile);
    answer(env.requests[1], desktop);
    assert.equal(first.length, 1);
    assert.ok(env.disk['$sandbox/eudic-public-mobile.json']);
    assert.ok(env.disk['$sandbox/eudic-public-desktop.json']);
    const savedMobile = env.disk['$sandbox/eudic-public-mobile.json'];
    const savedDesktop = env.disk['$sandbox/eudic-public-desktop.json'];
    const writeCount = env.writes.length;

    const repeated = lookup();
    assert.equal(repeated.length, 1);
    assert.equal(env.requests.length, 2);
    assert.equal(env.writes.length, writeCount);
    assert.equal(env.disk['$sandbox/eudic-public-mobile.json'], savedMobile);
    assert.equal(env.disk['$sandbox/eudic-public-desktop.json'], savedDesktop);

    plugin._resetForTests();
    const reloaded = lookup();
    assert.equal(reloaded.length, 1);
    assert.equal(env.requests.length, 2);
    assert.equal(env.writes.length, writeCount);
  } finally { env.restore(); }
});

test('不匹配查询词的桌面词头和错误页不写入成功缓存', () => {
  const env = environment();
  try {
    const wrong = desktop.replace('>elude</span>', '>another</span>')
      + '<div class="spellHint"><a>evade</a></div>';
    const first = lookup();
    answer(env.requests[0], mobile);
    answer(env.requests[1], wrong);
    assert.equal(env.disk['$sandbox/eudic-public-desktop.json'], undefined);
    env.requests[2].handler({ error: true }); // 不相关页面的提示也不得进缓存
    assert.equal(first.length, 1);
    const second = lookup();
    assert.equal(env.requests.length, 4); // mobile 命中，desktop 再请求
    answer(env.requests[3], '<html><body>error</body></html>');
    assert.equal(second.length, 1);
    assert.equal(env.disk['$sandbox/eudic-public-desktop.json'], undefined);
  } finally { env.restore(); }
});

test('已验证候选词和主词再次命中缓存时均不重复写盘', () => {
  const env = environment();
  try {
    const embedding = '<h2 class="word"><span class="word">embedding</span></h2><div id="FCchild">n. 嵌入</div>';
    const embed = '<h2 class="word"><span class="word">embed</span></h2><div id="FCchild">vt. 嵌入<div id="trans"><span class="txtDisabled">时态:</span><span class="trans">embedded, embedding, embeds</span></div></div>';
    function begin() {
      const completed = [];
      plugin.translate({ text: 'embedding', onCompletion(value) { completed.push(value); } });
      return completed;
    }
    const first = begin();
    answer(env.requests[0], embedding);
    answer(env.requests[1], '<div class="spellHint"><a>embed</a></div>');
    answer(env.requests[2], embed);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].result.toDict.additions, [{ name: '原形', value: 'embed' }]);
    const writes = env.writes.length;
    const second = begin();
    assert.equal(second.length, 1);
    assert.equal(env.requests.length, 3);
    assert.equal(env.writes.length, writes);
  } finally { env.restore(); }
});
