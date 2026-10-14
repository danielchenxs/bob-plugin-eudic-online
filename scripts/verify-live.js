const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEntry } = require('../main.js');

const words = ['hello', 'good', 'run', 'take off', 'embedding'];
const absentWord = 'qzxqzxnotaword';
const output = path.join(__dirname, '..', 'tests', 'live-verification.json');

async function inspect(url, expectedType) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const bytes = (await response.arrayBuffer()).byteLength;
  const contentType = response.headers.get('content-type') || '';
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  assert.match(contentType, expectedType, `${url}: ${contentType}`);
  assert.ok(bytes > 0, `${url}: 响应为空`);
  return { url, status: response.status, contentType, bytes };
}

async function main() {
  const report = { checkedAt: new Date().toISOString(), words: [], absentWord: null, audio: [], examples: null };
  for (const word of words) {
    const url = `https://dict.eudic.net/mdicts/en/${encodeURIComponent(word)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    assert.equal(response.status, 200, `${word}: HTTP ${response.status}`);
    const entry = parseEntry(html, word);
    assert.ok(entry && entry.content.text, `${word}: 无释义`);
    assert.ok(entry.toDict.parts && entry.toDict.parts.some((part) => part.means.length), `${word}: 无原生中文释义`);
    assert.deepEqual(entry.toDict.phonetics.map((item) => item.type), ['us', 'uk'], `${word}: 缺少美英发音`);
    assert.doesNotMatch(entry.content.text, /!\[字\]/, `${word}: 释义含图片字`);
    if (word === 'hello' || word === 'embedding') {
      assert.ok(entry.raw.english.meaning, `${word}: 缺少英英释义`);
      assert.ok(entry.content.text.startsWith('**英英释义**'), `${word}: 英英释义应位于正文开头`);
      assert.doesNotMatch(entry.content.text, /英汉释义/, `${word}: 正文重复中文释义`);
    }
    report.words.push({ word, url, status: response.status, meaningChars: entry.content.text.length,
      exampleCount: entry.raw.examples.length, phonetics: entry.toDict.phonetics.map((item) => ({ type: item.type, value: item.value || null })) });
    for (const phonetic of entry.toDict.phonetics) {
      assert.ok(phonetic.tts && phonetic.tts.value, `${word}/${phonetic.type}: 无音频链接`);
      report.audio.push({ word, type: phonetic.type, ...await inspect(phonetic.tts.value, /^audio\//i) });
    }
  }
  const embedding = report.words.find((item) => item.word === 'embedding');
  const hello = report.words.find((item) => item.word === 'hello');
  assert.ok(embedding.phonetics.every((item) => item.value), 'embedding 应显示欧路通用音标');
  assert.ok(hello.phonetics.every((item) => item.value), 'hello 应有明确英美音标');
  assert.equal(embedding.exampleCount, 4, 'embedding 未取得四条听力例句');
  report.examples = { word: 'embedding', count: embedding.exampleCount };

  const absentUrl = `https://dict.eudic.net/mdicts/en/${absentWord}`;
  const absentResponse = await fetch(absentUrl, { signal: AbortSignal.timeout(15000) });
  assert.equal(absentResponse.status, 200, '不存在词查询失败');
  assert.equal(parseEntry(await absentResponse.text(), absentWord), null, '不存在词意外返回释义');
  report.absentWord = { word: absentWord, url: absentUrl, status: absentResponse.status, result: 'notFound' };

  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`通过：${report.words.length} 个纯文本词条、1 个不存在词、${report.audio.length} 条音频、${report.examples.count} 条内嵌听力例句。`);
  console.log(output);
}

main().catch((error) => {
  console.error(`线上验证失败：${error.message}`);
  process.exitCode = 1;
});
