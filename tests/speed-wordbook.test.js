const assert = require('node:assert/strict');
const test = require('node:test');
const plugin = require('../main.js');

const hello = `<h2 class="word"><span class="word">hello</span><span class="affiliate"><a data-rel="langid=en&txt=aGVsbG8"><uk>/həˈləʊ/</uk><us>/həˈloʊ/</us></a></span></h2><div id="FCchild"><ol><li>int. 喂；哈罗</li></ol></div><div id="FFchild"><div class="exp"><span class="cara">n.</span><ol><li>a greeting</li></ol></div></div>`;
const embed = `<h2 class="word"><span class="word">embed</span></h2><div id="FCchild">vt. 嵌入<div id="trans"><span class="txtDisabled">时态:</span><span class="trans">embedded, embedding, embeds</span></div></div>`;
const embedding = hello.replaceAll('hello', 'embedding').replace('喂；哈罗', '埋入,埋藏');
const wiki = { parse: { title: 'embedding', text: { '*': '<h2 id="English">English</h2><h3 id="Etymology">Etymology</h3><p>From embed + -ing.</p><h3 id="Noun">Noun</h3>' } } };
const noExtras = { showForms: 'off', showEtymology: 'off' };
const saved = {};
function setup(options = {}, file = false) {
  plugin._resetForTests();
  for (const key of ['$http', '$option', '$file', '$data', '$timer']) saved[key] = global[key];
  const requests = [];
  const timers = [];
  const disk = {};
  global.$option = { ...noExtras, ...options };
  global.$http = { request(request) { requests.push(request); } };
  global.$timer = {
    schedule(value) { const id = timers.length; timers.push({ id, ...value, active: true }); return id; },
    invalidate(id) { assert.equal(typeof id, 'number'); timers[id].active = false; }
  };
  if (file) {
    global.$file = { read(path) { return disk[path] ? { length: Buffer.byteLength(disk[path]), toUTF8: () => disk[path] } : null; }, write({ path, data }) { disk[path] = data.toUTF8(); return true; } };
    global.$data = { fromUTF8: (value) => ({ length: Buffer.byteLength(value), toUTF8: () => value }) };
  } else { delete global.$file; delete global.$data; }
  return { requests, timers, disk, restore() { for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete global[key]; else global[key] = saved[key];
  } } };
}
function begin(events, word = 'hello', cancelSignal) {
  const stream = [], final = [];
  plugin.translate({ text: word, cancelSignal, onStream: (value) => stream.push(value), onCompletion: (value) => final.push(value) });
  return { stream, final };
}
function respond(request, data, statusCode = 200) { request.handler({ response: { statusCode }, data }); }

test('核心预览在桌面和 Wiki 完成前出现，末尾仍为原生中文且元数据并行', () => {
  const env = setup({ showForms: 'on', showEtymology: 'on' });
  try {
    const out = begin(env, 'embedding');
    respond(env.requests[0], embedding);
    assert.equal(out.stream.length, 1);
    assert.match(out.stream[0].content.text, /embedding[\s\S]*美 \/həˈloʊ\/[\s\S]*埋入,埋藏/);
    assert.doesNotMatch(out.stream[0].content.text, /资料暂无/);
    assert.equal(out.final.length, 0);
    assert.equal(env.requests.length, 3);
    const desktop = env.requests.find((item) => item.url.includes('/dicts/en/embedding'));
    const etymology = env.requests.find((item) => item.url.includes('en.wiktionary.org'));
    respond(etymology, wiki);
    assert.equal(out.final.length, 0);
    respond(desktop, '<div class="spellHint"><a>embed</a></div>');
    assert.equal(env.requests.length, 5); // Wiki 的明确词干另有一次依赖请求
    respond(env.requests.find((item) => item.url.endsWith('/mdicts/en/embed')), embed);
    respond(env.requests.find((item) => item.url.endsWith('page=embed')), { error: 'missing' }, 404);
    assert.equal(out.final.length, 1);
    assert.deepEqual(out.final[0].result.toDict.additions, [{ name: '原形', value: 'embed' }]);
    assert.match(out.final[0].result.content.text, /构词/);
    assert.doesNotMatch(out.final[0].result.content.text, /埋入,埋藏/);
  } finally { env.restore(); }
});

test('重复和迟到回调、取消后均不再更新 UI 或发起同步', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'secret', wordbookId: '0' });
  try {
    let cancel;
    let disposed = 0;
    const signal = { subscribe(fn) { cancel = fn; return { dispose() { disposed++; } }; } };
    const out = begin(env, 'hello', signal);
    respond(env.requests[0], hello);
    assert.equal(out.stream.length, 1);
    assert.equal(env.requests.length, 2);
    cancel();
    respond(env.requests[1], {}, 201);
    respond(env.requests[0], hello);
    assert.equal(out.final.length, 0);
    assert.equal(out.stream.length, 1);
    assert.equal(disposed, 1);
    assert.equal(env.timers[0].active, false);
    env.timers[0].handler(); // 已取消的计时器不产生账号退避
    const next = begin(env);
    respond(env.requests[2], hello);
    assert.equal(env.requests[3].method, 'POST');
    respond(env.requests[3], {}, 201);
    assert.equal(next.final.length, 1);
  } finally { env.restore(); }
});

test('自动同步默认关闭，缺凭据时也无账号请求且查询完成', () => {
  const env = setup();
  try {
    const off = begin(env);
    respond(env.requests[0], hello);
    assert.equal(env.requests.length, 1);
    assert.equal(off.final.length, 1);
    assert.doesNotMatch(off.final[0].result.content?.text || '', /生词本/);
    global.$option.autoAdd = 'on';
    const missing = begin(env);
    respond(env.requests[1], hello);
    assert.equal(env.requests.length, 2);
    assert.match(missing.final[0].result.content.text, /请填写欧路 API 授权/);
  } finally { env.restore(); }
});

test('POST 准确携带完整授权、ID、查询词；201 后本机去重与分组隔离', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: '  Token secret  ', wordbookId: '0' }, true);
  try {
    const first = begin(env);
    respond(env.requests[0], hello);
    const post = env.requests[1];
    assert.equal(post.url, 'https://api.frdic.com/api/open/v1/studylist/words');
    assert.equal(post.method, 'POST');
    assert.equal(post.header.Authorization, 'Token secret');
    assert.equal(post.header['Content-Type'], 'application/json');
    assert.deepEqual(post.body, { language: 'en', category_id: '0', words: ['hello'] });
    assert.equal(first.final.length, 0);
    respond(post, {}, 201);
    assert.equal(env.timers[0].id, 0);
    assert.equal(env.timers[0].active, false);
    env.timers[0].handler(); // 即使原回调迟到，也不触发失败退避
    assert.match(first.final[0].result.content.text, /已加入欧路生词本/);
    const second = begin(env);
    assert.equal(env.requests.length, 2); // 公共移动页缓存命中
    assert.match(second.final[0].result.content.text, /近期已加入（本机记录）/);
    assert.doesNotMatch(JSON.stringify(env.disk), /Token secret/);
    global.$option.wordbookId = '2';
    const third = begin(env);
    assert.equal(env.requests[2].body.category_id, '2');
    respond(env.requests[2], {}, 201);
    assert.equal(third.final.length, 1);
  } finally { env.restore(); }
});

test('401、429、500、网络错误仅给通用状态，限频退避且释义保留', () => {
  for (const status of [401, 403, 429, 500, 0]) {
    const env = setup({ autoAdd: 'on', eudicAuthorization: 'secret', wordbookId: '0' });
    try {
      const first = begin(env);
      respond(env.requests[0], hello);
      if (status) respond(env.requests[1], { message: 'secret' }, status);
      else env.requests[1].handler({ error: { message: 'secret' } });
      assert.equal(first.final.length, 1);
      assert.equal(first.final[0].result.toDict.parts[0].means[0], '喂；哈罗');
      assert.doesNotMatch(first.final[0].result.content.text, /secret/);
      const second = begin(env);
      respond(env.requests[2], hello);
      assert.equal(env.requests.length, 3);
      assert.match(second.final[0].result.content.text, /同步暂缓/);
    } finally { env.restore(); }
  }
});

test('验证开关、分组检查和 401 均只有通用结果', () => {
  const env = setup();
  try {
    const values = [];
    plugin.pluginValidate((value) => values.push(value));
    assert.deepEqual(values, [{ result: true }]);
    assert.equal(env.requests.length, 0);
    global.$option = { autoAdd: 'on', eudicAuthorization: 'Token secret', wordbookId: '0' };
    plugin.pluginValidate((value) => values.push(value));
    assert.equal(env.requests[0].url, 'https://api.frdic.com/api/open/v1/studylist/category?language=en');
    assert.equal(env.requests[0].header.Authorization, 'Token secret');
    respond(env.requests[0], { data: [{ id: 0 }] });
    assert.deepEqual(values[1], { result: true });
    assert.equal(env.timers[0].id, 0);
    assert.equal(env.timers[0].active, false);
    plugin.pluginValidate((value) => values.push(value));
    respond(env.requests[1], { data: [{ id: 2, name: 'private' }] });
    assert.equal(values[2].result, false);
    assert.doesNotMatch(JSON.stringify(values), /Token secret|private/);
  } finally { env.restore(); }
});

test('公共缓存从磁盘重载后按新配置重解析，过期与损坏触发重新请求', () => {
  const env = setup({ showEnglish: 'on' }, true);
  try {
    const first = begin(env);
    respond(env.requests[0], hello);
    assert.match(first.final[0].result.content.text, /英英释义/);
    assert.ok(env.disk['$sandbox/eudic-public-mobile.json']);
    plugin._resetForTests();
    global.$option.showEnglish = 'off';
    const second = begin(env);
    assert.equal(env.requests.length, 1);
    assert.doesNotMatch(second.final[0].result.content?.text || '', /英英释义/);
    env.disk['$sandbox/eudic-public-mobile.json'] = '{broken';
    plugin._resetForTests();
    begin(env);
    assert.equal(env.requests.length, 2);
  } finally { env.restore(); }
});

test('缓存过期、尺寸上限、写入失败和单类 200 条上限不影响核心查询', () => {
  const env = setup({}, true);
  const oldNow = Date.now;
  try {
    const time = Date.now();
    Date.now = () => time;
    env.disk['$sandbox/eudic-public-mobile.json'] = JSON.stringify({ version: 1, entries: {
      hello: { time: time - 86400001, value: hello },
      bad: { time, value: 'x'.repeat(600001) }
    } });
    const originalWrite = global.$file.write;
    global.$file.write = () => { throw new Error('disk unavailable'); };
    const out = begin(env);
    assert.equal(env.requests.length, 1);
    respond(env.requests[0], hello);
    assert.equal(out.final.length, 1);
    global.$file.write = originalWrite;
    plugin._resetForTests();
    const entries = {};
    for (let index = 0; index < 205; index++) entries[`word${index}`] = { time: time - index, value: hello };
    env.disk['$sandbox/eudic-public-mobile.json'] = JSON.stringify({ version: 1, entries });
    begin(env);
    respond(env.requests[1], hello);
    const stored = JSON.parse(env.disk['$sandbox/eudic-public-mobile.json']);
    assert.ok(Object.keys(stored.entries).length <= 200);
  } finally { Date.now = oldNow; env.restore(); }
});

test('授权换行拒绝、账号隔离、配置快照与验证错误均不泄露凭据', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'secret\n', wordbookId: '0' });
  try {
    const bad = begin(env);
    respond(env.requests[0], hello);
    assert.equal(env.requests.length, 1);
    assert.match(bad.final[0].result.content.text, /请填写欧路 API 授权/);
    global.$option.eudicAuthorization = 'account A';
    const first = begin(env);
    global.$option.eudicAuthorization = 'account B';
    respond(env.requests[1], hello);
    assert.equal(env.requests[2].header.Authorization, 'account A');
    respond(env.requests[2], { message: 'account A' }, 401);
    assert.match(first.final[0].result.content.text, /欧路授权失败/);
    const second = begin(env);
    respond(env.requests[3], hello);
    assert.equal(env.requests[4].header.Authorization, 'account B');
    respond(env.requests[4], {}, 201);
    assert.equal(second.final.length, 1);
    const validations = [];
    plugin.pluginValidate((value) => validations.push(value));
    respond(env.requests[5], { message: 'account B' }, 401);
    assert.equal(validations[0].result, false);
    assert.doesNotMatch(JSON.stringify(validations), /account B/);
  } finally { env.restore(); }
});

test('含验证在内每分钟最多 25 次账号请求，并在同步超时后结算一次', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'secret', wordbookId: '0' });
  try {
    for (let index = 0; index < 25; index++) {
      plugin.pluginValidate(() => {});
      respond(env.requests[index], { data: [{ id: 0 }] });
    }
    const checks = [];
    plugin.pluginValidate((value) => checks.push(value));
    assert.equal(env.requests.length, 25);
    assert.equal(checks[0].result, false);
  } finally { env.restore(); }
  const timed = setup({ autoAdd: 'on', eudicAuthorization: 'secret', wordbookId: '0' });
  try {
    const out = begin(timed);
    respond(timed.requests[0], hello);
    const timer = timed.timers.find((item) => item.interval === 3);
    timer.handler();
    assert.equal(out.final.length, 1);
    assert.match(out.final[0].result.content.text, /同步网络超时/);
    respond(timed.requests[1], {}, 201);
    assert.equal(out.final.length, 1);
  } finally { timed.restore(); }
});

test('401 同授权的哈希阻断可从私有沙盒恢复，更换授权可继续', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'old secret', wordbookId: '0' }, true);
  try {
    const first = begin(env);
    respond(env.requests[0], hello);
    respond(env.requests[1], {}, 401);
    assert.equal(first.final.length, 1);
    const privateFile = env.disk['$sandbox/eudic-private-blocks.json'];
    assert.ok(privateFile);
    assert.doesNotMatch(privateFile, /old secret/);
    plugin._resetForTests();
    const blocked = begin(env);
    assert.equal(blocked.final.length, 1); // 公开词条缓存命中
    assert.equal(env.requests.length, 2);
    assert.match(blocked.final[0].result.content.text, /同步暂缓/);
    global.$option.eudicAuthorization = 'new secret';
    begin(env);
    assert.equal(env.requests.length, 3);
    assert.equal(env.requests[2].header.Authorization, 'new secret');
  } finally { env.restore(); }
});

test('18 位生词本 ID 全程作为字符串发送并按字符串验证', () => {
  const id = '132303016416635230';
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'secret', wordbookId: id });
  try {
    const out = begin(env);
    respond(env.requests[0], hello);
    assert.equal(env.requests[1].body.category_id, id);
    assert.equal(typeof env.requests[1].body.category_id, 'string');
    respond(env.requests[1], {}, 201);
    assert.equal(out.final.length, 1);
    const checks = [];
    plugin.pluginValidate((value) => checks.push(value));
    respond(env.requests[2], { data: [{ id }] });
    assert.deepEqual(checks, [{ result: true }]);
  } finally { env.restore(); }
});

test('constructor 查询不读取 Object 原型属性作为词条缓存', () => {
  const env = setup({}, true);
  try {
    const out = begin(env, 'constructor');
    assert.equal(env.requests.length, 1);
    respond(env.requests[0], hello.replaceAll('hello', 'constructor'));
    assert.equal(out.final.length, 1);
    assert.equal(out.final[0].result.toDict.word, 'constructor');
    assert.ok(JSON.parse(env.disk['$sandbox/eudic-public-mobile.json']).entries.constructor);
  } finally { env.restore(); }
});

test('公共缓存按整个 JSON 文件字符和 UTF-8 字节上限淘汰旧条目', () => {
  const env = setup({}, true);
  try {
    const now = Date.now();
    const entries = {};
    for (let index = 0; index < 4; index++) {
      entries[`old${index}`] = { time: now - 100 - index, value: 'x'.repeat(440000) };
    }
    env.disk['$sandbox/eudic-public-mobile.json'] = JSON.stringify({ version: 1, entries });
    const large = hello + '中'.repeat(140000); // 单条在上限内，总量会超过文件上限
    const out = begin(env);
    respond(env.requests[0], large);
    assert.equal(out.final.length, 1);
    const stored = env.disk['$sandbox/eudic-public-mobile.json'];
    assert.ok(stored.length <= 2000000);
    assert.ok(Buffer.byteLength(stored) <= 2400000);
    assert.ok(Object.keys(JSON.parse(stored).entries).length <= 200);
    plugin._resetForTests();
    const cached = begin(env);
    assert.equal(env.requests.length, 1);
    assert.equal(cached.final.length, 1);
  } finally { env.restore(); }
});

test('私有限频文件重载后同授权第 26 次仍被挡，新授权独立计数', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'same account', wordbookId: '0' }, true);
  try {
    for (let index = 0; index < 25; index++) {
      plugin.pluginValidate(() => {});
      respond(env.requests[index], { data: [{ id: '0' }] });
    }
    const rateFile = env.disk['$sandbox/eudic-private-rate.json'];
    assert.ok(rateFile);
    assert.doesNotMatch(rateFile, /same account/);
    plugin._resetForTests();
    const blocked = [];
    plugin.pluginValidate((value) => blocked.push(value));
    assert.equal(blocked[0].result, false);
    assert.equal(env.requests.length, 25);
    global.$option.eudicAuthorization = 'another account';
    plugin.pluginValidate(() => {});
    assert.equal(env.requests.length, 26);
    respond(env.requests[25], { data: [{ id: '0' }] });
  } finally { env.restore(); }
});

test('403 一小时退避在重载后仍有效，到期才恢复；429 同样退避', () => {
  for (const status of [403, 429]) {
    const env = setup({ autoAdd: 'on', eudicAuthorization: `account ${status}`, wordbookId: '0' }, true);
    const originalNow = Date.now;
    const start = originalNow();
    Date.now = () => start;
    try {
      plugin.pluginValidate(() => {});
      respond(env.requests[0], {}, status);
      plugin._resetForTests();
      const blocked = [];
      plugin.pluginValidate((value) => blocked.push(value));
      assert.equal(blocked[0].result, false);
      assert.equal(env.requests.length, 1);
      Date.now = () => start + 3600001;
      plugin._resetForTests();
      plugin.pluginValidate(() => {});
      assert.equal(env.requests.length, 2);
    } finally { Date.now = originalNow; env.restore(); }
  }
});

test('30 分钟窗口保守 450 次上限在重载后维持，到边界恢复', () => {
  const env = setup({ autoAdd: 'on', eudicAuthorization: 'window account', wordbookId: '0' }, true);
  const originalNow = Date.now;
  const start = originalNow();
  Date.now = () => start;
  try {
    const hash = require('node:crypto').createHash('sha256').update('window account').digest('hex');
    env.disk['$sandbox/eudic-private-rate.json'] = JSON.stringify({ version: 1, accounts: {
      [hash]: { calls: Array.from({ length: 450 }, (_, index) => start - 60001 - index), until: 0 }
    } });
    plugin._resetForTests();
    const blocked = [];
    plugin.pluginValidate((value) => blocked.push(value));
    assert.equal(blocked[0].result, false);
    assert.equal(env.requests.length, 0);
    Date.now = () => start + 1800000;
    plugin._resetForTests();
    plugin.pluginValidate(() => {});
    assert.equal(env.requests.length, 1);
    respond(env.requests[0], { data: [{ id: '0' }] });
  } finally { Date.now = originalNow; env.restore(); }
});
