const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// ---- CSV parser (handles quotes, commas and newlines inside quotes) ----
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  const head = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---- Exchange rates (live from open.er-api.com, with approximate fallback) ----
// Fallback numbers are approximate and only used if the live fetch fails.
const R = { usdPerBdt: 1 / 122, nokPerBdt: 0.0836, live: false, date: '' };
async function refreshRates() {
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) })).json();
    const b = j.rates && j.rates.BDT, n = j.rates && j.rates.NOK;
    if (b > 0 && n > 0) { R.usdPerBdt = 1 / b; R.nokPerBdt = n / b; R.live = true; R.date = j.time_last_update_utc || ''; console.log('Live exchange rates loaded.'); }
  } catch (e) { console.warn('Could not fetch live exchange rates; using approximate fallback.'); }
}
refreshRates();
setInterval(refreshRates, 12 * 3600e3).unref();

function priceOf(i) {
  if (i.pa == null) return null;
  const usd = i.pc === 'USD' ? i.pa : i.pa * R.usdPerBdt;
  const nok = i.pc === 'USD' ? i.pa * (R.nokPerBdt / R.usdPerBdt) : i.pa * R.nokPerBdt;
  return { usd: Math.round(usd), nok: Math.round(nok) };
}

// ---- Text helpers for forgiving search ----
const split = s => String(s).toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim();
function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function tokenScore(t, words) {
  const numeric = /^\d+$/.test(t); let best = -1;
  for (const w of words) {
    let sc = -1;
    if (w === t) sc = 0;
    else if (w.startsWith(t)) sc = 0.5;
    else if (!numeric && t.length >= 3 && w.includes(t)) sc = 1.5;
    else if (!numeric && t.length >= 4) {
      const d = Math.min(lev(t, w), lev(t, w.slice(0, t.length)));
      if (d <= (t.length <= 5 ? 1 : 2)) sc = 3 + d;
    }
    if (sc >= 0 && (best < 0 || sc < best)) best = sc;
  }
  return best;
}
function matchScore(item, q) {
  if (!q.tokens.length) return 0;
  if (item.compact.includes(q.compact)) return -1;
  let total = 0;
  for (const t of q.tokens) { const s = tokenScore(t, item.words); if (s < 0) return null; total += s; }
  return total;
}

function readRows(file) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  if (/\.json$/i.test(file)) {
    let j = JSON.parse(raw);
    if (!Array.isArray(j)) j = Object.values(j).find(Array.isArray) || Object.values(j);
    return j.filter(x => x && typeof x === 'object').map(o => Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)])));
  }
  return parseCSV(raw);
}

// ---- Load the dataset: any .csv/.json in /data (real files win over "sample") ----
function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  const all = fs.readdirSync(DATA_DIR).filter(f => /\.(csv|json)$/i.test(f));
  const files = all.filter(f => !/^extra/i.test(f)).sort((a, b) => a.startsWith('sample') - b.startsWith('sample'));
  if (!files.length) { console.error('Put a .csv or .json file in the data folder.'); process.exit(1); }
  const file = files[0];
  let rows = readRows(file);
  if (!rows.length) { console.error('The data file is empty.'); process.exit(1); }
  // Files named extra*.csv / extra*.json are merged in as additional phones.
  const mainKeys = new Set(Object.keys(rows[0]));
  for (const f of all.filter(f => /^extra/i.test(f))) {
    const add = readRows(f);
    const odd = [...new Set(add.flatMap(r => Object.keys(r)))].filter(k => !mainKeys.has(k));
    if (odd.length) console.warn(`Warning: ${f} has columns not in ${file}: ${odd.join(', ')}`);
    rows = rows.concat(add);
    console.log(`Added ${add.length} phones from ${f}`);
  }
  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  rows = rows.map(r => Object.fromEntries(allKeys.map(k => [k, r[k] ?? ''])));

  const keys = Object.keys(rows[0]);
  const norm = k => k.toLowerCase().replace(/[^a-z]/g, '');
  const find = re => keys.find(k => re.test(norm(k)));
  const brandK = find(/^(brand|company|manufacturer|maker)/);
  let nameK = find(/^(model|name|device|title|phone)/);
  if (nameK === brandK) nameK = keys.find(k => k !== brandK && /model|name|device|title/.test(norm(k)));
  nameK = nameK || keys.find(k => k !== brandK) || keys[0];
  const imgK = find(/^(image|img|picture|photo|thumbnail)/) ||
    keys.find(k => /^https?:\/\/\S+\.(jpe?g|png|webp)/i.test(rows[0][k]));
  const priceKs = keys.filter(k => /price|cost/i.test(k))
    .sort((a, b) => /usd|dollar/i.test(b) - /usd|dollar/i.test(a));

  const items = rows.map((r, id) => {
    const brand = brandK ? r[brandK] : '';
    let name = r[nameK] || '(unnamed)';
    if (brand && !name.toLowerCase().startsWith(brand.toLowerCase())) name = brand + ' ' + name;
    const img = imgK && /^https?:\/\//i.test(r[imgK]) ? r[imgK] : '';
    let pa = null, pc = 'BDT', pt = '';
    for (const k of priceKs) {
      const v = r[k] || '', m = v.match(/\d[\d,]*(?:\.\d+)?/), n = m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
      if (n > 0) { pa = n; pc = /usd|dollar/i.test(k) || /\$|usd/i.test(v) ? 'USD' : 'BDT'; break; }
      if (v.trim() && !pt) pt = v.trim();
    }
    const sp = split(name);
    return { id, name, brand, img, pa, pc, pt, words: sp.split(' '), compact: sp.replace(/ /g, '') };
  });

  console.log(`Loaded ${items.length} phones from ${file} (name: "${nameK}", brand: "${brandK}", image: "${imgK}", price: ${priceKs.map(k => `"${k}"`).join(', ') || 'none'})`);
  const cov = {};
  for (const i of items) { const c = cov[i.brand || '(none)'] ||= { n: 0, p: 0 }; c.n++; if (i.pa != null) c.p++; }
  const gaps = Object.entries(cov).filter(([, c]) => c.p < c.n).sort((a, b) => (b[1].n - b[1].p) - (a[1].n - a[1].p)).slice(0, 10);
  if (gaps.length) console.log('Brands with missing prices (priced/total): ' + gaps.map(([b, c]) => `${b} ${c.p}/${c.n}`).join(', '));
  return { rows, items, priceKs };
}

const { rows, items, priceKs } = load();
const outItem = i => ({ id: i.id, name: i.name, brand: i.brand, hasImg: !!i.img, price: priceOf(i), priceText: i.pt });
const app = express();

app.get('/api/meta', (req, res) => res.json({ total: items.length, ratesLive: R.live, ratesDate: R.date }));

app.get('/api/search', (req, res) => {
  const sp = split(req.query.q || '');
  const q = { tokens: sp.split(' ').filter(Boolean), compact: sp.replace(/ /g, '') };
  const brand = String(req.query.brand || '');
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const matches = [], brandCounts = {};
  for (const i of items) {
    const s = matchScore(i, q);
    if (s === null) continue;
    matches.push([s, i]);
    brandCounts[i.brand || 'Other'] = (brandCounts[i.brand || 'Other'] || 0) + 1;
  }
  let list = brand ? matches.filter(([, i]) => i.brand === brand) : matches;
  if (q.tokens.length) list = list.slice().sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
  res.json({ total: list.length, brandCounts, items: list.slice(offset, offset + 48).map(([, i]) => outItem(i)) });
});

app.get('/api/device/:id', (req, res) => {
  const i = items[+req.params.id];
  if (!i) return res.status(404).json({ error: 'Not found' });
  const specs = Object.fromEntries(Object.entries(rows[i.id]).filter(([k]) => !priceKs.includes(k)));
  res.json({ ...outItem(i), specs });
});

// ---- Image proxy by phone id (not by URL, so it can't be used as an open proxy) ----
const imgCache = new Map();
app.get('/api/img/:id', async (req, res) => {
  const i = items[+req.params.id];
  if (!i || !i.img) return res.status(404).end();
  let hit = imgCache.get(i.id);
  if (!hit || (!hit.buf && Date.now() - hit.t > 10 * 60e3)) {
    try {
      const r = await fetch(i.img, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'phone-finder/1.0' } });
      const type = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      hit = r.ok && type.startsWith('image/') && buf.length < 3e6 ? { buf, type, t: Date.now() } : { buf: null, t: Date.now() };
    } catch (e) { hit = { buf: null, t: Date.now() }; }
    imgCache.set(i.id, hit);
    if (imgCache.size > 500) imgCache.delete(imgCache.keys().next().value);
  }
  if (!hit.buf) return res.status(404).end();
  res.set('Content-Type', hit.type);
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(hit.buf);
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Phone search running at http://localhost:${PORT}`));
