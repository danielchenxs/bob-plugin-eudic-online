const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'info.json'), 'utf8'));
const target = path.join(dist, `eudic-online-${metadata.version}.bobplugin`);
fs.mkdirSync(dist, { recursive: true });
if (fs.existsSync(target)) fs.unlinkSync(target);
execFileSync('zip', ['-q', '-X', target, 'info.json', 'main.js'], { cwd: root });
console.log(target);
