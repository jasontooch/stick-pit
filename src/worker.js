import { DurableObject } from 'cloudflare:workers';
import * as BJ from './blackjack.js';
import { cleanName, START_BUCKS } from './rules.js';
export { Match } from './match.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const lobby = env => env.LOBBY.get(env.LOBBY.idFromName('global'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (p.startsWith('/api/') || p === '/ws/lobby') return lobby(env).fetch(req);
    const m = p.match(/^\/ws\/match\/([0-9a-f]{64})$/);
    if (m) {
      let id; try { id = env.MATCH.idFromString(m[1]); } catch { return json({ error: 'bad match' }, 400); }
      return env.MATCH.get(id).fetch(req);
    }
    return env.ASSETS.fetch(req);   // the game page and anything else in /public
  },
};

async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const hex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); };

/* The lobby: one global object that owns accounts, Stick Bucks, the leaderboard, the online count,
   matchmaking and blackjack. Lobby sockets hibernate between messages, so idle players cost nothing. */
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players(pid TEXT PRIMARY KEY, tok TEXT, name TEXT, bucks INTEGER, bj TEXT, created INTEGER, updated INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS players_bucks ON players(bucks DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, humans INTEGER, ends_at INTEGER, updated INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ratelimit(k TEXT PRIMARY KEY, n INTEGER, t INTEGER)`);
  }
  one(q, ...a) { const r = [...this.sql.exec(q, ...a)]; return r[0] || null; }
  async auth(req, url) {
    const pid = req.headers.get('x-pid') || url.searchParams.get('pid'), tok = req.headers.get('x-tok') || url.searchParams.get('tok');
    if (!pid || !tok || pid.length > 40 || tok.length > 80) return null;
    const row = this.one('SELECT * FROM players WHERE pid=?', pid);
    if (!row || row.tok !== await sha(tok)) return null;
    return row;
  }
  limited(key, max, windowMs) {   // simple fixed-window rate limit
    const now = Date.now(), r = this.one('SELECT n,t FROM ratelimit WHERE k=?', key);
    if (!r || now - r.t > windowMs) { this.sql.exec('INSERT OR REPLACE INTO ratelimit(k,n,t) VALUES(?,?,?)', key, 1, now); return false; }
    if (r.n >= max) return true;
    this.sql.exec('UPDATE ratelimit SET n=n+1 WHERE k=?', key); return false;
  }
  top() { return [...this.sql.exec('SELECT pid,name,bucks FROM players ORDER BY bucks DESC LIMIT 10')].map(r => ({ id: r.pid.slice(0, 8), name: r.name, bucks: r.bucks })); }
  rankOf(bucks) { return this.one('SELECT COUNT(*) AS n FROM players WHERE bucks>?', bucks).n + 1; }
  online() { return this.ctx.getWebSockets().filter(w => w.readyState === 1).length; }
  broadcast(o) { const s = JSON.stringify(o); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch {} } }
  boardSoon() { const now = Date.now(); if (now - (this.lastBoard || 0) > 1500) { this.lastBoard = now; this.broadcast({ t: 'board', top: this.top(), online: this.online() }); } else this.ctx.storage.setAlarm(now + 1600); }
  async alarm() { this.lastBoard = Date.now(); this.broadcast({ t: 'board', top: this.top(), online: this.online() }); }
  me(row) { return { pid: row.pid, name: row.name, bucks: row.bucks, rank: this.rankOf(row.bucks) }; }
  credit(pid, n) { this.sql.exec('UPDATE players SET bucks=MAX(0,bucks+?), updated=? WHERE pid=?', Math.floor(n), Date.now(), pid); }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, ip = req.headers.get('cf-connecting-ip') || 'local';
    // ---- calls from match rooms (never reachable from the internet: the worker only forwards /api and /ws/lobby here)
    if (p === '/internal/award') { const b = await req.json(); this.credit(b.pid, b.n); this.boardSoon(); this.pushBank(b.pid); return json({ ok: 1 }); }
    if (p === '/internal/match') { const b = await req.json();
      if (b.done) this.sql.exec('DELETE FROM matches WHERE id=?', b.id);
      else this.sql.exec('INSERT OR REPLACE INTO matches(id,humans,ends_at,updated) VALUES(?,?,?,?)', b.id, b.humans, b.ends_at, Date.now());
      return json({ ok: 1 }); }

    if (p === '/api/hello') return json({ stickpit: 1, online: this.online() });
    if (p === '/api/register' && req.method === 'POST') {
      if (this.limited('reg:' + ip, 60, 3600e3)) return json({ error: 'Too many new players from this network, try later' }, 429);
      const b = await req.json().catch(() => ({})), pid = 'p' + hex(10), tok = hex(24), now = Date.now();
      this.sql.exec('INSERT INTO players(pid,tok,name,bucks,bj,created,updated) VALUES(?,?,?,?,?,?,?)', pid, await sha(tok), cleanName(b.name), START_BUCKS, null, now, now);
      return json({ pid, tok, ...this.me(this.one('SELECT * FROM players WHERE pid=?', pid)) });
    }
    if (p === '/api/leaderboard') { const row = await this.auth(req, url); return json({ top: this.top(), online: this.online(), me: row ? this.me(row) : null }); }
    const row = await this.auth(req, url);
    if (p === '/ws/lobby') {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (!row) return json({ error: 'unknown player' }, 401);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ pid: row.pid });
      queueMicrotask(() => { try { pair[1].send(JSON.stringify({ t: 'hello', me: this.me(row), top: this.top(), online: this.online() })); } catch {} this.broadcast({ t: 'online', n: this.online() }); });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (!row) { if (req.method === 'POST') await req.text().catch(() => {}); return json({ error: 'unknown player' }, 401); }
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM ratelimit WHERE t<?', Date.now() - 7200e3);
    if (p === '/api/me') return json(this.me(row));
    if (p === '/api/name' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      this.sql.exec('UPDATE players SET name=?, updated=? WHERE pid=?', cleanName(b.name), Date.now(), row.pid); this.boardSoon();
      return json(this.me(this.one('SELECT * FROM players WHERE pid=?', row.pid)));
    }
    if (p === '/api/bj' && req.method === 'POST') {
      if (this.limited('bj:' + row.pid, 120, 60e3)) return json({ error: 'Slow down' }, 429);
      const b = await req.json().catch(() => ({}));
      let st = null; try { st = row.bj ? JSON.parse(row.bj) : null; } catch {}
      const r = BJ.act(st, row.bucks, String(b.action || 'state'), b.bet);
      this.sql.exec('UPDATE players SET bj=?, bucks=?, updated=? WHERE pid=?', JSON.stringify(r.state), r.bank, Date.now(), row.pid);
      if (r.bank !== row.bucks) this.boardSoon();
      return json({ table: BJ.view(r.state), bank: r.bank, error: r.error || null });
    }
    return json({ error: 'not found' }, 404);
  }

  pushBank(pid) {
    const row = this.one('SELECT * FROM players WHERE pid=?', pid); if (!row) return;
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.pid === pid) { try { ws.send(JSON.stringify({ t: 'me', me: this.me(row) })); } catch {} } }
  }
  async webSocketMessage(ws, msg) {
    let m; try { m = JSON.parse(msg); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', online: this.online() })); return; }
    if (m.t === 'queue') {
      const row = this.one('SELECT * FROM players WHERE pid=?', a.pid); if (!row) return;
      if (this.limited('q:' + a.pid, 12, 60e3)) { ws.send(JSON.stringify({ t: 'queueError', error: 'Slow down a little' })); return; }
      try { const r = await this.matchmake(row, m.loadout || {}); ws.send(JSON.stringify({ t: 'match', ...r })); }
      catch (e) { ws.send(JSON.stringify({ t: 'queueError', error: 'Could not find a match, try again' })); }
    }
  }
  async webSocketClose(ws) { try { ws.close(); } catch {} this.broadcast({ t: 'online', n: this.online() }); }
  async webSocketError(ws) { this.broadcast({ t: 'online', n: this.online() }); }

  // Join the busiest running match that has a free human slot and enough time left; otherwise open a new one
  // (bots fill every empty slot, and step aside as people join).
  async matchmake(row, loadout) {
    const now = Date.now();
    this.sql.exec('DELETE FROM matches WHERE ends_at<? OR updated<?', now, now - 300e3);
    const open = [...this.sql.exec('SELECT id,humans FROM matches WHERE humans<6 AND ends_at>? ORDER BY humans DESC LIMIT 3', now + 45e3)];
    const ticket = hex(16), body = JSON.stringify({ pid: row.pid, name: row.name, loadout, ticket });
    for (const m of open) {
      this.sql.exec('UPDATE matches SET humans=humans+1 WHERE id=?', m.id);   // reserve before awaiting so two joiners can't overfill
      const res = await this.env.MATCH.get(this.env.MATCH.idFromString(m.id)).fetch('https://match/admit', { method: 'POST', body }).then(r => r.json()).catch(() => null);
      if (res && res.ok) return { id: m.id, ticket };
      this.sql.exec('UPDATE matches SET humans=6 WHERE id=?', m.id);
    }
    const id = this.env.MATCH.newUniqueId(), sid = id.toString();
    const stub = this.env.MATCH.get(id);
    await stub.fetch('https://match/init', { method: 'POST', body: JSON.stringify({ id: sid }) });
    const res = await stub.fetch('https://match/admit', { method: 'POST', body }).then(r => r.json());
    if (!res.ok) throw new Error('admit failed');
    this.sql.exec('INSERT OR REPLACE INTO matches(id,humans,ends_at,updated) VALUES(?,?,?,?)', sid, 1, res.endsAt, now);
    return { id: sid, ticket };
  }
}
