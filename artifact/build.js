'use strict';
// Builds artifact/gazecast.html: the whole GazeCast page in one file, with the
// demo phone running inside the page (no local bridge needed).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const css = read('web', 'css', 'app.css');
const html = read('web', 'index.html');

// Body markup between <body ...> and the first <script>.
const bodyStart = html.indexOf('>', html.indexOf('<body')) + 1;
const bodyEnd = html.indexOf('<script src=');
const markup = html.slice(bodyStart, bodyEnd).trim();

const scripts = [
  read('web', 'js', 'icons.js'),
  read(__dirname === ROOT ? '.' : 'artifact', 'fakebridge.js'),
  read('web', 'js', 'player.js'),
  read('web', 'js', 'demo.js'),
  read('web', 'js', 'gaze.js'),
  read('web', 'js', 'app.js'),
].map((s) => s.replace(/<\/script/gi, '<\\/script'));

const out = `<title>GazeCast</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
${css}
</style>

${markup}

<script>
try { document.documentElement.dataset.theme = 'dark'; document.body.dataset.screen = 'boot'; } catch (e) { /* ignore */ }
</script>
<script>
${scripts.join('\n</script>\n<script>\n')}
</script>
`;

fs.writeFileSync(path.join(__dirname, 'gazecast.html'), out);
console.log('Wrote artifact/gazecast.html', out.length, 'bytes');
