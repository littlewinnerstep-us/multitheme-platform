import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'dist-pages');
const BASE = (process.env.PAGES_BASE || '/multitheme-platform').replace(/\/$/, '');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Copy static storefront directories
for (const dir of ['cdn', 'collections', 'products', 'pages', 'blogs', 'cart']) {
  copyDir(path.join(ROOT, dir), path.join(OUT, dir));
}
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data', 'seed-catalog.json'), path.join(OUT, 'data', 'seed-catalog.json'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'preview.html'), path.join(OUT, 'preview.html'));
copyDir(path.join(ROOT, 'public'), OUT);

// Provide /admin/index.html for GitHub Pages directory routing
fs.mkdirSync(path.join(OUT, 'admin'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(OUT, 'admin', 'index.html'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Rewrite root-relative paths in HTML files for GitHub Pages subpath deployment
function rewriteHtml(filePath, isAdmin = false) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html
    .replace(/<script[^>]+src="https:\/\/cdn\.shopify\.com\/[^"]+"[^>]*><\/script>/gi, '')
    .replace(/<script[^>]*>\s*await import\("https:\/\/cdn\.shopify\.com\/[^"]+"\)[\s\S]*?<\/script>/gi, '');

  const prefixes = ['cdn', 'collections', 'products', 'pages', 'blogs', 'cart', 'admin', 'mt-bridge', 'gh-pages-demo', 'preview.html'];
  for (const p of prefixes) {
    html = html.replace(new RegExp(`(href|src|action)=("|')\\/${p}`, 'g'), `$1=$2${BASE}/${p}`);
  }
  html = html.replace(/href=("|')\/("|')/g, `href=$1${BASE}/$2`);
  html = html.replace(/src=("|')\/(admin\.(?:js|css))/g, `src=$1${BASE}/$2`).replace(/href=("|')\/(admin\.css)/g, `href=$1${BASE}/$2`);

  const headInject = `<script>window.__MT_BASE__ = ${JSON.stringify(BASE)};</script><script src="${BASE}/gh-pages-demo.js"></script>`;
  if (isAdmin) {
    html = html.replace('</head>', `${headInject}</head>`);
  } else if (path.basename(filePath) !== 'preview.html') {
    const bridgeHead = `${headInject}<link rel="stylesheet" href="${BASE}/mt-bridge.css">`;
    html = html.replace('</head>', `${bridgeHead}</head>`);
    html = html.replace('</body>', `<script src="${BASE}/mt-bridge.js" defer></script></body>`);
  } else {
    html = html.replace('value="/', `value="${BASE}/`).replaceAll('href="/"', `href="${BASE}/"`).replaceAll('src="/"', `src="${BASE}/"`);
  }
  fs.writeFileSync(filePath, html, 'utf8');
}

function walkHtml(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkHtml(full);
    else if (ent.name.endsWith('.html')) {
      const isAdmin = full.endsWith('admin.html') || full.endsWith(path.join('admin', 'index.html'));
      rewriteHtml(full, isAdmin);
    }
  }
}

walkHtml(OUT);

// Rewrite root paths in mt-bridge.js & admin.js
for (const jsFile of ['mt-bridge.js', 'admin.js']) {
  const fp = path.join(OUT, jsFile);
  if (fs.existsSync(fp)) {
    let txt = fs.readFileSync(fp, 'utf8');
    txt = txt
      .replaceAll('href="/admin"', `href="${BASE}/admin/"`)
      .replaceAll('href="/preview.html"', `href="${BASE}/preview.html"`)
      .replaceAll('/cdn/shop/files/', `${BASE}/cdn/shop/files/`)
      .replaceAll('`/products/', `\`${BASE}/products/`)
      .replaceAll('href="/products/', `href="${BASE}/products/`)
      .replaceAll('`/?store=', `\`${BASE}/?store=`);
    fs.writeFileSync(fp, txt, 'utf8');
  }
}

console.log(`Built GitHub Pages static demo in ${OUT} (base=${BASE})`);
