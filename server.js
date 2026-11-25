// Veřejný ovladač žárovky. Web (za Caddy/Cloudflare) na :8080, agent (domácí PC) na :9000.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const AGENT_KEY = process.env.AGENT_KEY || (() => { throw new Error('Nastav AGENT_KEY'); })();
const COOLDOWN = (+process.env.COOLDOWN_MIN || 2) * 60 * 1000; // jedna akce za N minut na IP
const EXEMPT = (process.env.EXEMPT_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const exempt = ip => EXEMPT.some(e => e.endsWith('*') ? ip.startsWith(e.slice(0, -1)) : ip === e);
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || '';
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const LOG = process.env.LOG_FILE || '/data/actions.jsonl';

let state = {};
let lastAgentSeen = 0, lastStateAt = 0;
const queue = [];
let waiting = null;
const lastAction = new Map();
let history = [];
const CHAT = process.env.CHAT_FILE || '/data/chat.jsonl';
let chat = [];
try { chat = fs.readFileSync(CHAT, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(m => !m.del).slice(-100); } catch {}
const deleted = new Set();
try { fs.readFileSync(CHAT, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).forEach(m => m.del && deleted.add(m.del)); } catch {}
chat = chat.filter(m => !deleted.has(m.id));
const lastChat = new Map();
const CHAT_GAP = 10000; // jedna zpráva za 10 s
const cleanText = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
try { history = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-100).map(JSON.parse); } catch {}

const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 4096) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function keyOk(req) {
  const k = Buffer.from(req.headers['x-agent-key'] || ''), a = Buffer.from(AGENT_KEY);
  return k.length === a.length && crypto.timingSafeEqual(k, a);
}
function flush() {
  if (waiting && queue.length) { const res = waiting; waiting = null; json(res, 200, { cmds: queue.splice(0) }); }
}
const SCENES = {1:'Oceán',2:'Romantika',3:'Západ slunce',4:'Párty',5:'Krb',6:'Útulno',7:'Les',8:'Pastelky',9:'Probuzení',10:'Na spaní',11:'Teplá bílá',12:'Denní světlo',13:'Studená bílá',14:'Noční světlo',15:'Soustředění',16:'Relax',17:'Pravé barvy',18:'TV',19:'Pro rostliny',20:'Jaro',21:'Léto',22:'Podzim',23:'Hlubina',24:'Džungle',25:'Mojito',26:'Klub',27:'Vánoce',28:'Halloween',29:'Svíčka',30:'Zlatá bílá',31:'Pulz',32:'Steampunk'};
const EFFECTS = { rainbow: 'Duha', strobe: 'Stroboskop', police: 'Policie', breathe: 'Dýchání' };
const SCENES_EN = {1:'Ocean',2:'Romance',3:'Sunset',4:'Party',5:'Fireplace',6:'Cozy',7:'Forest',8:'Pastel colors',9:'Wake up',10:'Bedtime',11:'Warm white',12:'Daylight',13:'Cool white',14:'Night light',15:'Focus',16:'Relax',17:'True colors',18:'TV time',19:'Plant growth',20:'Spring',21:'Summer',22:'Fall',23:'Deep dive',24:'Jungle',25:'Mojito',26:'Club',27:'Christmas',28:'Halloween',29:'Candlelight',30:'Golden white',31:'Pulse',32:'Steampunk'};
const EFFECTS_EN = { rainbow: 'Rainbow', strobe: 'Strobe', police: 'Police', breathe: 'Breathing' };
// stav od agenta: jen čísla/boolean ze známých polí (ochrana proti XSS, kdyby někdo ukradl klíč agenta)
function cleanState(x) {
  const o = {};
  for (const k of ['r', 'g', 'b', 'c', 'w', 'dimming', 'temp', 'sceneId', 'speed', 'rssi']) if (Number.isFinite(x[k])) o[k] = x[k];
  if (typeof x.state === 'boolean') o.state = x.state;
  return o;
}
// IPv6: limit na celou /64 (jinak by šlo měnit adresy a obcházet limit)
const rateKey = ip => ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
setInterval(() => { const now = Date.now(); for (const [k, t] of lastAction) if (now - t > COOLDOWN) lastAction.delete(k); for (const [k, t] of lastChat) if (now - t > CHAT_GAP) lastChat.delete(k); }, 60000);
function sanitize(c) {
  const p = {};
  if (typeof c.on === 'boolean') p.state = c.on;
  if (Number.isFinite(c.dimming)) p.dimming = Math.max(10, Math.min(100, Math.round(c.dimming)));
  if (/^#[0-9a-f]{6}$/i.test(c.color || '')) { p.r = parseInt(c.color.slice(1, 3), 16); p.g = parseInt(c.color.slice(3, 5), 16); p.b = parseInt(c.color.slice(5, 7), 16); }
  if (Number.isFinite(c.temp)) p.temp = Math.max(2200, Math.min(6500, Math.round(c.temp)));
  if (Number.isInteger(c.scene) && SCENES[c.scene]) { p.state = true; p.sceneId = c.scene; p.speed = Number.isFinite(c.speed) ? Math.max(20, Math.min(200, Math.round(c.speed))) : 100; }
  if (typeof c.effect === 'string' && Object.hasOwn(EFFECTS, c.effect)) { p.state = true; p.effect = c.effect; }
  return Object.keys(p).length ? p : null;
}
function describe(p, en) {
  if (p.state === false) return en ? 'turned off' : 'vypnul/a';
  if (p.effect) return en ? 'effect ' + EFFECTS_EN[p.effect] : 'efekt ' + EFFECTS[p.effect];
  if (p.sceneId) return en ? 'scene ' + SCENES_EN[p.sceneId] : 'scéna ' + SCENES[p.sceneId];
  const a = [];
  if (p.r != null) a.push((en ? 'colour #' : 'barva #') + [p.r, p.g, p.b].map(v => v.toString(16).padStart(2, '0')).join(''));
  if (p.dimming != null) a.push((en ? 'brightness ' : 'jas ') + p.dimming + ' %');
  if (p.temp != null) a.push((en ? 'white ' : 'bílá ') + p.temp + ' K');
  return a.length ? a.join(', ') : en ? 'turned on' : 'zapnul/a';
}
const maskIp = ip => ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + ':…' : ip.replace(/\.\d+$/, '.x');
const flag = cc => /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1' ? String.fromCodePoint(...[...cc].map(ch => 0x1F1A5 + ch.charCodeAt(0))) : '🏳️';

function act(p, who) {
  const entry = { t: new Date().toISOString(), ip: who.ip, cc: who.cc, ua: (who.ua || '').slice(0, 200), what: describe(p), cmd: p, src: who.src };
  history.push(entry); if (history.length > 100) history.shift();
  fs.appendFile(LOG, JSON.stringify(entry) + '\n', () => {});
  console.log(entry.t, entry.cc, entry.ip, entry.what);
  if (queue.length > 50) queue.shift();
  queue.push(p); flush();
  if (N8N_WEBHOOK && who.src !== 'n8n') fetch(N8N_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: entry.t, country: entry.cc, flag: flag(entry.cc), ip: who.ip, ipMasked: maskIp(who.ip), admin: exempt(who.ip), action: entry.what, cmd: p }) }).catch(e => console.log('n8n webhook:', e.message));
}
const internalOk = req => { const k = Buffer.from(req.headers['x-internal-key'] || ''), a = Buffer.from(INTERNAL_KEY); return INTERNAL_KEY && k.length === a.length && crypto.timingSafeEqual(k, a); };

// --- web (pro všechny) ---
http.createServer(async (req, res) => {
  const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const cc = (req.headers['cf-ipcountry'] || 'XX').toUpperCase();
  const url = new URL(req.url, 'http://x');
  const en = req.headers['x-lang'] === 'en';
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.method === 'GET' && IMG[url.pathname]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(IMG[url.pathname]); }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const wait = exempt(ip) ? 0 : Math.max(0, (lastAction.get(rateKey(ip)) || 0) + COOLDOWN - Date.now());
    return json(res, 200, { ...state, online: Date.now() - lastAgentSeen < 20000, bulbOk: Date.now() - lastStateAt < 70000, wait, me: exempt(ip) ? 'admin' : null, chat: chat.slice(-50).map(m => ({ id: m.id, t: m.t, flag: flag(m.cc), cc: m.cc, name: exempt(m.ip) ? 'lafe' : m.name, admin: exempt(m.ip), text: m.text })), log: history.slice(-30).reverse().map(h => ({ t: h.t, flag: flag(h.cc), cc: h.cc, ip: h.src === 'n8n' ? (en ? '🤖 n8n automation' : '🤖 automatizace n8n') : exempt(h.ip) ? 'lafe · admin' : maskIp(h.ip), admin: exempt(h.ip) || h.src === 'n8n', what: en && h.cmd ? describe(h.cmd, true) : h.what })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const k = rateKey(ip), w = exempt(ip) ? 0 : (lastChat.get(k) || 0) + CHAT_GAP - Date.now();
    if (w > 0) return json(res, 429, { error: (en ? 'Slow down, next message in ' : 'Pomaleji, další zpráva za ') + Math.ceil(w / 1000) + ' s' });
    const b = await body(req), text = cleanText(b.text, 300), name = cleanText(b.name, 24) || 'Anonym';
    if (!text) return json(res, 400, { error: en ? 'Write a message' : 'Napiš nějakou zprávu' });
    lastChat.set(k, Date.now());
    const m = { id: crypto.randomBytes(6).toString('hex'), t: new Date().toISOString(), ip, cc, name, text };
    chat.push(m); if (chat.length > 100) chat.shift();
    fs.appendFile(CHAT, JSON.stringify(m) + '\n', () => {});
    console.log(m.t, cc, ip, 'chat', name + ':', text);
    if (N8N_WEBHOOK) fetch(N8N_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'chat', time: m.t, country: cc, flag: flag(cc), ip, ipMasked: maskIp(ip), admin: exempt(ip), action: '💬 ' + name + ': ' + text }) }).catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/delete') {
    if (!exempt(ip)) return json(res, 403, { error: en ? 'Admin only' : 'Jen pro admina' });
    const id = String((await body(req)).id || '');
    chat = chat.filter(m => m.id !== id);
    fs.appendFile(CHAT, JSON.stringify({ del: id }) + '\n', () => {});
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/cmd') {
    const wait = exempt(ip) ? 0 : (lastAction.get(rateKey(ip)) || 0) + COOLDOWN - Date.now();
    if (wait > 0) return json(res, 429, { error: (en ? 'Next action in ' : 'Další akce až za ') + Math.ceil(wait / 1000) + ' s', wait });
    const p = sanitize(await body(req));
    if (!p) return json(res, 400, { error: en ? 'Invalid command' : 'Neplatný příkaz' });
    lastAction.set(rateKey(ip), Date.now());
    act(p, { ip, cc, ua: req.headers['user-agent'] });
    return json(res, 200, { ok: true, wait: exempt(ip) ? 0 : COOLDOWN });
  }
  if (url.pathname === '/internal/state' && internalOk(req)) return json(res, 200, { ...state, online: Date.now() - lastAgentSeen < 20000, bulbOk: Date.now() - lastStateAt < 70000 });
  if (req.method === 'POST' && url.pathname === '/internal/cmd') {
    if (!internalOk(req)) return json(res, 403, { error: 'bad key' });
    const p = sanitize(await body(req));
    if (!p) return json(res, 400, { error: en ? 'Invalid command' : 'Neplatný příkaz' });
    act(p, { ip: 'n8n', cc: 'XX', src: 'n8n' });
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}).listen(8080, () => console.log('Web na :8080'));

// --- agent (domácí PC), jediné, co je venku přes port hostu ---
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!keyOk(req)) return json(res, 403, { error: 'bad key' });
  lastAgentSeen = Date.now();
  if (req.method === 'GET' && url.pathname === '/agent/poll') {
    if (waiting) json(waiting, 200, { cmds: [] });
    waiting = res;
    const t = setTimeout(() => { if (waiting === res) { waiting = null; json(res, 200, { cmds: [] }); } }, 10000);
    res.on('close', () => { clearTimeout(t); if (waiting === res) waiting = null; });
    return flush();
  }
  if (req.method === 'POST' && url.pathname === '/agent/state') { const b = await body(req); if (b.state && typeof b.state === 'object') { state = cleanState(b.state); lastStateAt = Date.now(); } return json(res, 200, { ok: true }); }
  json(res, 404, { error: 'not found' });
}).listen(9000, () => console.log('Agent na :9000'));

const PAGE = fs.readFileSync(__dirname + '/index.html', 'utf8');
const IMG = { '/og.png': fs.readFileSync(__dirname + '/og.png'), '/icon.png': fs.readFileSync(__dirname + '/icon.png') };
