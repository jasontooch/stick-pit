import { DurableObject } from 'cloudflare:workers';
import * as BJ from './blackjack.js';
import { START_BUCKS, SHOP, SLOTS, checkUsername } from './rules.js';
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

const enc = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sha(s) { return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
const hex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return toHex(a); };
async function pbkdf2(pass, salt) {   // passwords are only ever stored as a salted PBKDF2 hash
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const MAX_PARTY = 6;

/* The lobby: one global object that owns accounts and logins, Stick Bucks, the shop, the leaderboard,
   who's online, friends, parties, matchmaking and blackjack. Lobby sockets hibernate between messages. */
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.sql = ctx.storage.sql;
    sql.exec('DROP TABLE IF EXISTS players');   // the anonymous accounts from launch day: fresh start for everyone
    sql.exec(`CREATE TABLE IF NOT EXISTS accounts(uid TEXT PRIMARY KEY, name TEXT, name_lc TEXT UNIQUE, salt TEXT, hash TEXT, bucks INTEGER, kills INTEGER,
      owned TEXT, loadout TEXT, bj TEXT, created INTEGER, updated INTEGER, seen INTEGER)`);
    sql.exec('CREATE INDEX IF NOT EXISTS accounts_bucks ON accounts(bucks DESC)');
    sql.exec('CREATE TABLE IF NOT EXISTS sessions(tok TEXT PRIMARY KEY, uid TEXT, created INTEGER, used INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS friends(a TEXT, b TEXT, state TEXT, created INTEGER, PRIMARY KEY(a,b))');
    sql.exec('CREATE TABLE IF NOT EXISTS parties(id TEXT PRIMARY KEY, leader TEXT, created INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS party_members(uid TEXT PRIMARY KEY, party TEXT, joined INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS invites(from_uid TEXT, to_uid TEXT, party TEXT, at INTEGER, PRIMARY KEY(from_uid,to_uid))');
    sql.exec('CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, humans INTEGER, ends_at INTEGER, updated INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS ratelimit(k TEXT PRIMARY KEY, n INTEGER, t INTEGER)');
  }
  // ---------- small helpers ----------
  one(q, ...a) { const r = [...this.sql.exec(q, ...a)]; return r[0] || null; }
  all(q, ...a) { return [...this.sql.exec(q, ...a)]; }
  acct(uid) { return this.one('SELECT * FROM accounts WHERE uid=?', uid); }
  limited(key, max, windowMs) {
    const now = Date.now(), r = this.one('SELECT n,t FROM ratelimit WHERE k=?', key);
    if (!r || now - r.t > windowMs) { this.sql.exec('INSERT OR REPLACE INTO ratelimit(k,n,t) VALUES(?,?,?)', key, 1, now); return false; }
    if (r.n >= max) return true;
    this.sql.exec('UPDATE ratelimit SET n=n+1 WHERE k=?', key); return false;
  }
  parse(s, d) { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } }
  me(a) {
    if (!a) return null;
    return { uid: a.uid, name: a.name, bucks: a.bucks, kills: a.kills, owned: this.parse(a.owned, []), loadout: this.parse(a.loadout, {}),
      rank: this.one('SELECT COUNT(*) AS n FROM accounts WHERE bucks>?', a.bucks).n + 1 };
  }
  top() { return this.all('SELECT uid,name,bucks FROM accounts ORDER BY bucks DESC LIMIT 10').map(r => ({ id: r.uid, name: r.name, bucks: r.bucks })); }
  async auth(req, url) {
    const tok = req.headers.get('x-tok') || url.searchParams.get('tok');
    if (!tok || tok.length > 80) return null;
    const s = this.one('SELECT uid FROM sessions WHERE tok=?', await sha(tok)); if (!s) return null;
    return this.acct(s.uid);
  }
  async newSession(uid) { const tok = hex(24); this.sql.exec('INSERT INTO sessions(tok,uid,created,used) VALUES(?,?,?,?)', await sha(tok), uid, Date.now(), Date.now()); return tok; }

  // ---------- sockets: who's online ----------
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  att(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  socksOf(uid) { return this.socks().filter(w => this.att(w).uid === uid); }
  sendTo(uid, o) { const s = JSON.stringify(o); for (const w of this.socksOf(uid)) { try { w.send(s); } catch {} } }
  onlineMap() { const m = new Map(); for (const w of this.socks()) { const a = this.att(w); if (!a.uid) continue; const cur = m.get(a.uid); if (!cur || a.status === 'match') m.set(a.uid, { uid: a.uid, name: a.name, status: a.status || 'lobby' }); } return m; }
  friendSet(uid) { return new Set(this.all("SELECT a,b FROM friends WHERE state='accepted' AND (a=? OR b=?)", uid, uid).map(r => (r.a === uid ? r.b : r.a))); }
  pushOnline() {   // each socket gets the online list with its own friends marked
    const on = [...this.onlineMap().values()].slice(0, 200);
    for (const w of this.socks()) { const a = this.att(w); if (!a.uid) continue; const fr = this.friendSet(a.uid);
      try { w.send(JSON.stringify({ t: 'online', n: on.length, list: on.filter(x => x.uid !== a.uid).map(x => ({ ...x, friend: fr.has(x.uid) })) })); } catch {} }
  }
  pushBoard() { const s = JSON.stringify({ t: 'board', top: this.top() }); for (const w of this.socks()) { try { w.send(s); } catch {} } }
  boardSoon() { const now = Date.now(); if (now - (this.lastBoard || 0) > 1500) { this.lastBoard = now; this.pushBoard(); } else this.ctx.storage.setAlarm(now + 1600); }
  async alarm() { this.lastBoard = Date.now(); this.pushBoard(); }
  pushMe(uid) { const a = this.acct(uid); if (a) this.sendTo(uid, { t: 'me', me: this.me(a) }); }

  // ---------- friends ----------
  friendsOf(uid) {
    const on = this.onlineMap(), rows = this.all('SELECT * FROM friends WHERE a=? OR b=?', uid, uid);
    const name = id => { const a = this.one('SELECT name FROM accounts WHERE uid=?', id); return a ? a.name : '?'; };
    const out = { friends: [], requests: [], sent: [] };
    for (const r of rows) {
      const other = r.a === uid ? r.b : r.a, o = { uid: other, name: name(other), online: on.has(other), status: on.has(other) ? on.get(other).status : 'offline' };
      if (r.state === 'accepted') out.friends.push(o); else if (r.b === uid) out.requests.push(o); else out.sent.push(o);
    }
    out.friends.sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
    return out;
  }
  pushFriends(uid) { this.sendTo(uid, { t: 'friends', ...this.friendsOf(uid) }); }

  // ---------- parties ----------
  partyOf(uid) { const m = this.one('SELECT party FROM party_members WHERE uid=?', uid); return m ? m.party : null; }
  partyView(pid) {
    if (!pid) return null; const p = this.one('SELECT * FROM parties WHERE id=?', pid); if (!p) return null;
    const on = this.onlineMap();
    const members = this.all('SELECT m.uid, a.name, a.loadout FROM party_members m JOIN accounts a ON a.uid=m.uid WHERE m.party=? ORDER BY m.joined', pid)
      .map(r => ({ uid: r.uid, name: r.name, loadout: this.parse(r.loadout, {}), online: on.has(r.uid), status: on.has(r.uid) ? on.get(r.uid).status : 'offline' }));
    return { id: pid, leader: p.leader, members, max: MAX_PARTY };
  }
  pushParty(pid) { const v = this.partyView(pid); if (!v) return; for (const m of v.members) this.sendTo(m.uid, { t: 'party', party: v }); }
  leaveParty(uid) {
    const pid = this.partyOf(uid); if (!pid) return;
    this.sql.exec('DELETE FROM party_members WHERE uid=?', uid);
    const rest = this.all('SELECT uid FROM party_members WHERE party=? ORDER BY joined', pid);
    if (rest.length <= 1) { for (const r of rest) { this.sql.exec('DELETE FROM party_members WHERE uid=?', r.uid); this.sendTo(r.uid, { t: 'party', party: null }); } this.sql.exec('DELETE FROM parties WHERE id=?', pid); }
    else { const p = this.one('SELECT leader FROM parties WHERE id=?', pid); if (p && p.leader === uid) this.sql.exec('UPDATE parties SET leader=? WHERE id=?', rest[0].uid, pid); this.pushParty(pid); }
    this.sendTo(uid, { t: 'party', party: null });
  }

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, ip = req.headers.get('cf-connecting-ip') || 'local', now = Date.now();
    // calls from match rooms (the worker only forwards /api and /ws/lobby here, so these aren't reachable from outside)
    if (p === '/internal/award') {
      const b = await req.json();
      this.sql.exec('UPDATE accounts SET bucks=MAX(0,bucks+?), kills=kills+?, updated=? WHERE uid=?', Math.floor(b.n || 0), b.kill ? 1 : 0, now, b.uid);
      this.boardSoon(); this.pushMe(b.uid); return json({ ok: 1 });
    }
    if (p === '/internal/match') { const b = await req.json();
      if (b.done) this.sql.exec('DELETE FROM matches WHERE id=?', b.id);
      else this.sql.exec('INSERT OR REPLACE INTO matches(id,humans,ends_at,updated) VALUES(?,?,?,?)', b.id, b.humans, b.ends_at, now);
      return json({ ok: 1 }); }

    if (p === '/api/hello') return json({ stickpit: 2, accounts: true, online: this.onlineMap().size });
    if (p === '/api/leaderboard') return json({ top: this.top(), online: this.onlineMap().size });
    if (p === '/api/shop') return json({ shop: SHOP });
    if (p === '/api/signup' && req.method === 'POST') {
      if (this.limited('su:' + ip, 30, 3600e3)) return json({ error: 'Too many new accounts from this network, try again later' }, 429);
      const b = await req.json().catch(() => ({})), name = String(b.name || '').trim(), pass = String(b.pass || '');
      const bad = checkUsername(name); if (bad) return json({ error: bad }, 400);
      if (pass.length < 6 || pass.length > 72) return json({ error: 'Passwords are 6 to 72 characters' }, 400);
      if (this.one('SELECT uid FROM accounts WHERE name_lc=?', name.toLowerCase())) return json({ error: 'That username is taken' }, 409);
      const uid = 'u' + hex(10), salt = hex(16), hash = await pbkdf2(pass, salt);
      try { this.sql.exec('INSERT INTO accounts(uid,name,name_lc,salt,hash,bucks,kills,owned,loadout,bj,created,updated,seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        uid, name, name.toLowerCase(), salt, hash, START_BUCKS, 0, '[]', '{}', null, now, now, now); }
      catch { return json({ error: 'That username is taken' }, 409); }
      this.boardSoon();
      return json({ tok: await this.newSession(uid), me: this.me(this.acct(uid)) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})), name = String(b.name || '').trim().toLowerCase(), pass = String(b.pass || '');
      if (this.limited('li:' + ip, 40, 600e3) || this.limited('ln:' + name, 10, 600e3)) return json({ error: 'Too many tries. Wait a few minutes and try again' }, 429);
      const a = this.one('SELECT * FROM accounts WHERE name_lc=?', name);
      if (!a || !same(await pbkdf2(pass, a.salt), a.hash)) return json({ error: 'Wrong username or password' }, 401);
      return json({ tok: await this.newSession(a.uid), me: this.me(a) });
    }
    const a = await this.auth(req, url);
    if (p === '/ws/lobby') {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (!a) return json({ error: 'not logged in' }, 401);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ uid: a.uid, name: a.name, status: 'lobby' });
      this.sql.exec('UPDATE accounts SET seen=? WHERE uid=?', now, a.uid);
      queueMicrotask(() => {
        const pid = this.partyOf(a.uid);
        try { pair[1].send(JSON.stringify({ t: 'hello', me: this.me(a), top: this.top(), party: this.partyView(pid), ...this.friendsOf(a.uid),
          invites: this.all('SELECT i.from_uid, i.party, x.name FROM invites i JOIN accounts x ON x.uid=i.from_uid WHERE i.to_uid=? AND i.at>?', a.uid, now - 120e3).map(r => ({ from: r.from_uid, name: r.name, party: r.party })) })); } catch {}
        this.pushOnline(); for (const f of this.friendSet(a.uid)) this.pushFriends(f); if (pid) this.pushParty(pid);
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (!a) { if (req.method === 'POST') await req.text().catch(() => {}); return json({ error: 'not logged in' }, 401); }
    if (Math.random() < 0.02) { this.sql.exec('DELETE FROM ratelimit WHERE t<?', now - 7200e3); this.sql.exec('DELETE FROM invites WHERE at<?', now - 600e3); this.sql.exec('DELETE FROM sessions WHERE used<?', now - 90 * 864e5); }
    if (p === '/api/me') { this.sql.exec('UPDATE sessions SET used=? WHERE uid=?', now, a.uid); return json(this.me(a)); }
    if (p === '/api/logout' && req.method === 'POST') { await req.text().catch(() => {}); const tok = req.headers.get('x-tok'); if (tok) this.sql.exec('DELETE FROM sessions WHERE tok=?', await sha(tok)); return json({ ok: 1 }); }
    if (p === '/api/buy' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})), it = SHOP[b.item]; if (!it) return json({ error: 'No such item' }, 400);
      const owned = this.parse(a.owned, []); if (owned.includes(b.item)) return json({ error: 'You already own that', me: this.me(a) }, 400);
      if (it.unlockKills && a.kills < it.unlockKills) return json({ error: `Unlocks at ${it.unlockKills} lifetime kills (you have ${a.kills})` }, 400);
      if (a.bucks < it.price) return json({ error: 'Not enough Stick Bucks' }, 400);
      owned.push(b.item);
      this.sql.exec('UPDATE accounts SET bucks=bucks-?, owned=?, updated=? WHERE uid=?', it.price, JSON.stringify(owned), now, a.uid);
      if (it.price) this.boardSoon();
      return json({ me: this.me(this.acct(a.uid)), item: b.item });
    }
    if (p === '/api/equip' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})), slot = String(b.slot || ''), item = String(b.item || 'none');
      if (!SLOTS.includes(slot)) return json({ error: 'No such slot' }, 400);
      const owned = this.parse(a.owned, []);
      if (item !== 'none' && (!owned.includes(item) || !SHOP[item] || SHOP[item].slot !== slot)) return json({ error: "You don't own that" }, 400);
      const lo = this.parse(a.loadout, {}); lo[slot] = item;
      this.sql.exec('UPDATE accounts SET loadout=?, updated=? WHERE uid=?', JSON.stringify(lo), now, a.uid);
      const pid = this.partyOf(a.uid); if (pid) this.pushParty(pid);
      return json({ me: this.me(this.acct(a.uid)) });
    }
    if (p === '/api/bj' && req.method === 'POST') {
      if (this.limited('bj:' + a.uid, 120, 60e3)) return json({ error: 'Slow down' }, 429);
      const b = await req.json().catch(() => ({}));
      const r = BJ.act(this.parse(a.bj, null), a.bucks, String(b.action || 'state'), b.bet);
      this.sql.exec('UPDATE accounts SET bj=?, bucks=?, updated=? WHERE uid=?', JSON.stringify(r.state), r.bank, now, a.uid);
      if (r.bank !== a.bucks) this.boardSoon();
      return json({ table: BJ.view(r.state), bank: r.bank, error: r.error || null });
    }
    return json({ error: 'not found' }, 404);
  }

  // ---------- lobby socket messages ----------
  async webSocketMessage(ws, msg) {
    let m; try { m = JSON.parse(msg); } catch { return; }
    const at = this.att(ws), uid = at.uid; if (!uid) return;
    const now = Date.now();
    if (this.limited('ws:' + uid, 120, 10e3)) return;
    const err = e => { try { ws.send(JSON.stringify({ t: 'toast', msg: e })); } catch {} };
    switch (m.t) {
      case 'ping': ws.send(JSON.stringify({ t: 'pong', n: this.onlineMap().size })); break;
      case 'status': {
        const s = ['lobby', 'match', 'bj'].includes(m.s) ? m.s : 'lobby';
        if (at.status !== s) { at.status = s; ws.serializeAttachment(at); this.pushOnline(); for (const f of this.friendSet(uid)) this.pushFriends(f); const pid = this.partyOf(uid); if (pid) this.pushParty(pid); }
        break; }
      case 'friendReq': {
        const to = String(m.to || ''); if (to === uid || !this.acct(to)) return;
        if (this.limited('fr:' + uid, 30, 3600e3)) return err('Slow down on friend requests');
        const ex = this.one('SELECT * FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', uid, to, to, uid);
        if (ex && ex.state === 'accepted') return err('Already friends');
        if (ex && ex.a === to) { this.sql.exec("UPDATE friends SET state='accepted' WHERE a=? AND b=?", to, uid); }   // they'd already asked you
        else if (!ex) this.sql.exec("INSERT INTO friends(a,b,state,created) VALUES(?,?,'pending',?)", uid, to, now);
        this.pushFriends(uid); this.pushFriends(to); this.pushOnline();
        this.sendTo(to, { t: 'toast', msg: `${at.name} sent you a friend request` });
        break; }
      case 'friendReply': {
        const from = String(m.from || '');
        if (m.accept) this.sql.exec("UPDATE friends SET state='accepted' WHERE a=? AND b=? AND state='pending'", from, uid);
        else this.sql.exec("DELETE FROM friends WHERE a=? AND b=? AND state='pending'", from, uid);
        this.pushFriends(uid); this.pushFriends(from); this.pushOnline();
        if (m.accept) this.sendTo(from, { t: 'toast', msg: `${at.name} accepted your friend request` });
        break; }
      case 'unfriend': { const o = String(m.uid || ''); this.sql.exec('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', uid, o, o, uid); this.pushFriends(uid); this.pushFriends(o); this.pushOnline(); break; }
      case 'invite': {
        const to = String(m.to || ''); if (to === uid || !this.acct(to)) return;
        if (!this.socksOf(to).length) return err("They're not online");
        if (this.limited('inv:' + uid, 40, 600e3)) return err('Slow down on invites');
        let pid = this.partyOf(uid);
        if (!pid) { pid = 'p' + hex(8); this.sql.exec('INSERT INTO parties(id,leader,created) VALUES(?,?,?)', pid, uid, now); this.sql.exec('INSERT INTO party_members(uid,party,joined) VALUES(?,?,?)', uid, pid, now); this.pushParty(pid); }
        if (this.partyOf(to) === pid) return err('Already in your party');
        if (this.one('SELECT COUNT(*) AS n FROM party_members WHERE party=?', pid).n >= MAX_PARTY) return err('Your party is full (6 max)');
        this.sql.exec('INSERT OR REPLACE INTO invites(from_uid,to_uid,party,at) VALUES(?,?,?,?)', uid, to, pid, now);
        this.sendTo(to, { t: 'invite', from: uid, name: at.name, party: pid });
        err(`Invite sent`);
        break; }
      case 'inviteReply': {
        const from = String(m.from || ''), inv = this.one('SELECT * FROM invites WHERE from_uid=? AND to_uid=?', from, uid);
        this.sql.exec('DELETE FROM invites WHERE from_uid=? AND to_uid=?', from, uid);
        if (!m.accept) { if (inv) this.sendTo(from, { t: 'toast', msg: `${at.name} declined your invite` }); break; }
        if (!inv || now - inv.at > 120e3 || !this.one('SELECT id FROM parties WHERE id=?', inv.party)) return err('That invite expired');
        if (this.one('SELECT COUNT(*) AS n FROM party_members WHERE party=?', inv.party).n >= MAX_PARTY) return err('That party is full');
        if (this.partyOf(uid) !== inv.party) { this.leaveParty(uid); this.sql.exec('INSERT OR REPLACE INTO party_members(uid,party,joined) VALUES(?,?,?)', uid, inv.party, now); }
        this.pushParty(inv.party);
        break; }
      case 'bjv': {   // your blackjack hand, mirrored to party members sitting at the same table
        const pid = this.partyOf(uid); if (!pid) break;
        const ok = /^(10|[2-9AJQK])[\u2660\u2665\u2666\u2663]$/;
        const p = (Array.isArray(m.p) ? m.p.slice(0, 11) : []).filter(c => typeof c === 'string' && ok.test(c));
        const res = ['win', 'lose', 'push', 'bj'].includes(m.res) ? m.res : null, bet = Math.max(0, Math.min(1e9, Math.floor(+m.bet || 0)));
        for (const r of this.all('SELECT uid FROM party_members WHERE party=?', pid)) if (r.uid !== uid) this.sendTo(r.uid, { t: 'bjv', uid, p, res, bet });
        break; }
      case 'leaveParty': this.leaveParty(uid); break;
      case 'kick': { const pid = this.partyOf(uid), p = pid && this.one('SELECT leader FROM parties WHERE id=?', pid), o = String(m.uid || '');
        if (p && p.leader === uid && o !== uid && this.partyOf(o) === pid) { this.leaveParty(o); this.sendTo(o, { t: 'toast', msg: 'You were removed from the party' }); } break; }
      case 'queue': {
        if (this.limited('q:' + uid, 12, 60e3)) { ws.send(JSON.stringify({ t: 'queueError', error: 'Slow down a little' })); return; }
        const pid = this.partyOf(uid); let members = [uid];
        if (pid) { const p = this.one('SELECT leader FROM parties WHERE id=?', pid);
          if (p.leader !== uid) { ws.send(JSON.stringify({ t: 'queueError', error: 'Your party leader starts the match' })); return; }
          members = this.all('SELECT uid FROM party_members WHERE party=? ORDER BY joined', pid).map(r => r.uid).filter(u => u === uid || this.socksOf(u).some(w => this.att(w).status !== 'match')); }
        try {
          const r = await this.matchmake(members.map(u => this.acct(u)).filter(Boolean));
          for (const t of r.tickets) this.sendTo(t.uid, { t: 'match', id: r.id, ticket: t.ticket, party: members.length > 1 });
        } catch (e) { ws.send(JSON.stringify({ t: 'queueError', error: 'Could not find a match, try again' })); }
        break; }
    }
  }
  async webSocketClose(ws) { const at = this.att(ws); try { ws.close(); } catch {} this.afterLeave(at.uid); }
  async webSocketError(ws) { const at = this.att(ws); this.afterLeave(at.uid); }
  afterLeave(uid) { this.pushOnline(); if (!uid) return; for (const f of this.friendSet(uid)) this.pushFriends(f); const pid = this.partyOf(uid); if (pid) this.pushParty(pid); }

  // Join the busiest running match with room for the whole group and enough time left; otherwise open a new one.
  async matchmake(accts) {
    const now = Date.now(), n = accts.length;
    this.sql.exec('DELETE FROM matches WHERE ends_at<? OR updated<?', now, now - 300e3);
    const admit = async (stub, a) => {
      const ticket = hex(16);
      const r = await stub.fetch('https://match/admit', { method: 'POST', body: JSON.stringify({ uid: a.uid, name: a.name, loadout: this.parse(a.loadout, {}), ticket }) }).then(r => r.json()).catch(() => null);
      return r && r.ok ? { uid: a.uid, ticket, endsAt: r.endsAt } : null;
    };
    for (const m of this.all('SELECT id,humans FROM matches WHERE humans<=? AND ends_at>? ORDER BY humans DESC LIMIT 3', 6 - n, now + 45e3)) {
      this.sql.exec('UPDATE matches SET humans=humans+? WHERE id=?', n, m.id);   // reserve before awaiting so two groups can't overfill
      const stub = this.env.MATCH.get(this.env.MATCH.idFromString(m.id)), tickets = [];
      for (const a of accts) { const t = await admit(stub, a); if (!t) break; tickets.push(t); }
      if (tickets.length === n) return { id: m.id, tickets };
      this.sql.exec('UPDATE matches SET humans=6 WHERE id=?', m.id);
      if (tickets.length) return { id: m.id, tickets };   // partial: the rest will get a fresh match next time they queue
    }
    const id = this.env.MATCH.newUniqueId(), sid = id.toString(), stub = this.env.MATCH.get(id);
    await stub.fetch('https://match/init', { method: 'POST', body: JSON.stringify({ id: sid }) });
    const tickets = []; for (const a of accts) { const t = await admit(stub, a); if (t) tickets.push(t); }
    if (!tickets.length) throw new Error('admit failed');
    this.sql.exec('INSERT OR REPLACE INTO matches(id,humans,ends_at,updated) VALUES(?,?,?,?)', sid, tickets.length, tickets[0].endsAt, now);
    return { id: sid, tickets };
  }
}
