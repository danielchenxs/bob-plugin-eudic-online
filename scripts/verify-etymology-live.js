const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseWiktionary, renderEtymology } = require('../main.js');

const words = ['embedding', 'embed', 'explore'];
const output = path.join(__dirname, '..', 'tests', 'wiktionary-verification.json');

async function main() {
  const report = { checkedAt: new Date().toISOString(), words: [] };
  for (const word of words) {
    const url = `https://en.wiktionary.org/w/api.php?action=parse&prop=text&format=json&redirects=1&page=${encodeURIComponent(word)}`;
    const body = execFileSync('curl', ['--location', '--fail', '--silent', '--show-error', '--max-time', '15', url],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const parsed = parseWiktionary(JSON.parse(body), word);
    assert.ok(parsed && parsed.entries.length, `${word}: 无 English Etymology 正文`);
    report.words.push({ word, url, title: parsed.title, entries: parsed.entries.map((entry) => ({
      id: entry.id, text: entry.text, formation: entry.formation
    })) });
    console.log(`${word}: ${renderEtymology(parsed).replace(/\n/g, ' ')}`);
  }
  const embedding = report.words[0].entries[0];
  const embed = report.words[1].entries[0];
  const explore = report.words[2].entries[0];
  assert.deepEqual(embedding.formation.items, ['embed', '-ing']);
  assert.deepEqual(embed.formation.items, ['em-', 'bed']);
  assert.equal(explore.formation, null);
  assert.match(explore.text, /second element is also explained as/);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(output);
}

main().catch((error) => {
  console.error(`词源线上验证失败：${error.message}`);
  process.exitCode = 1;
});
