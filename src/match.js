import { DurableObject } from 'cloudflare:workers';
import { GUNS, STARTER, pickGun, ITEM_SPOTS, POWER_SPOTS, SPAWNS, BOT_NAMES, MATCH_MS, MAX_FIGHTERS, RESPAWN_MS, SPAWN_INV_MS, PIT_CD_MS,
  KILL_BUCKS, STREAK_BUCKS, cleanName, rnd, pick, HX, HZ, BUBBLE, DEAGLE_RETURN_MS, SSJ_DMG, SSJ_HEAL, KILL_HEAL } from './rules.js';

const json = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const fin = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
const TICK_MS = 50;

/* One match room. The server owns everything that decides who wins: health, damage, kills, streaks,
   pickups, respawns, the clock and Stick Bucks payouts. Each player's browser runs their own movement
   and aim and reports shots; the first human in the room (the "host") also runs the bots. */
export class Match extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.f = new Map(); this.tickets = new Map(); this.items = []; this.pits = []; this.missiles = []; this.rains = [];
    this.phase = 'new'; this.seq = 0; this.host = null; this.usedNames = new Set(); this.bubbles = [];
    this.dg = { state: 'pad', holder: null, x: 0, z: 0, at: 0 };   // the match's one Golden Deagle
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') { if (this.phase === 'new') this.start((await req.json()).id); return json({ ok: 1 }); }
    if (url.pathname === '/admit') {
      const b = await req.json(), now = Date.now();
      for (const [k, t] of this.tickets) if (now - t.at > 30e3) this.tickets.delete(k);
      if (this.phase !== 'play' || this.humans().length + this.tickets.size >= MAX_FIGHTERS || now > this.endsAt - 40e3) return json({ ok: 0 });
      this.tickets.set(b.ticket, { ...b, at: now });
      return json({ ok: 1, endsAt: this.endsAt });
    }
    const tk = this.tickets.get(url.searchParams.get('ticket') || '');
    if (!tk || req.headers.get('upgrade') !== 'websocket') return new Response('No ticket for this match', { status: 403 });
    this.tickets.delete(url.searchParams.get('ticket'));
    const pair = new WebSocketPair(), ws = pair[1];
    ws.accept();
    this.join(tk, ws);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- lifecycle ----------
  start(id) {
    this.id = id; this.phase = 'play'; this.endsAt = Date.now() + MATCH_MS;
    this.items = [...ITEM_SPOTS.map(([x, z, c], i) => ({ i, kind: 'w', x, z, center: !!c, key: c ? 'gold' : pickGun(false), avail: true, at: 0 })),
                  ...POWER_SPOTS.map(([x, z, k], j) => ({ i: ITEM_SPOTS.length + j, kind: 'p', x, z, key: k, avail: true, at: 0 }))];
    while (this.f.size < MAX_FIGHTERS) this.addBot(true);
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.log('tick error', e && e.stack); } }, TICK_MS);
  }
  humans() { return [...this.f.values()].filter(f => f.kind === 'h'); }
  report(done) {
    const body = done ? { id: this.id, done: 1 } : { id: this.id, humans: this.humans().length + this.tickets.size, ends_at: this.endsAt };
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    this.ctx.waitUntil(lobby.fetch('https://lobby/internal/match', { method: 'POST', body: JSON.stringify(body) }).catch(() => {}));
  }
  award(f, n, why, kill) {
    if (f.kind !== 'h' || !n) return;
    f.earned += n; this.send(f, { t: 'earn', n, why: why || '' });
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    this.ctx.waitUntil(lobby.fetch('https://lobby/internal/award', { method: 'POST', body: JSON.stringify({ uid: f.uid, n, kill: !!kill }) }).catch(() => {}));
  }
  newFighter(o) {
    return Object.assign({ alive: false, hp: 100, sh: 0, pk: 0, kills: 0, deaths: 0, streak: 0, dstreak: 0, gun: STARTER, x: 0, y: 0, z: 0, s: null,
      lastShot: 0, lastSwing: 0, respawnAt: 0, inv: 0, pitAt: -1e12, strikeReady: false, striking: false, ssj: false, earned: 0, joinedAt: Date.now() }, o);
  }
  addBot(silent) {
    const names = BOT_NAMES.filter(n => ![...this.f.values()].some(f => f.name === n));
    const f = this.newFighter({ id: 'b' + (++this.seq), kind: 'b', name: pick(names.length ? names : BOT_NAMES), skill: rnd(0.22, 0.48), loadout: {} });
    this.f.set(f.id, f); this.spawn(f, silent);
    if (!silent) this.broadcast({ t: 'join', f: this.pub(f) });
  }
  join(tk, ws) {
    if (this.f.size >= MAX_FIGHTERS) {   // a bot steps aside: prefer one that's dead, else the lowest scorer
      const bots = [...this.f.values()].filter(f => f.kind === 'b').sort((a, b) => (a.alive - b.alive) || (a.kills - b.kills));
      if (bots[0]) { this.f.delete(bots[0].id); this.broadcast({ t: 'leave', id: bots[0].id }); }
    }
    const lo = {}; for (const k of ['head', 'neck', 'torso', 'back', 'legs', 'feet']) { const v = tk.loadout && tk.loadout[k]; lo[k] = typeof v === 'string' && v.length < 20 ? v : 'none'; }
    const f = this.newFighter({ id: 'h' + (++this.seq), kind: 'h', uid: tk.uid, name: cleanName(tk.name), loadout: lo, ws });
    this.f.set(f.id, f); this.spawn(f, true);
    if (!this.host || !this.f.has(this.host)) this.host = f.id;
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch { return; } try { this.onMsg(f, m); } catch (err) { console.log('msg error', err && err.stack); } });
    const gone = () => this.leave(f);
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    this.send(f, { t: 'welcome', you: f.id, host: this.host, endsIn: this.endsAt - Date.now(), f: [...this.f.values()].map(x => this.pub(x)),
      items: this.items.map(it => ({ i: it.i, key: it.avail ? it.key : null })), pits: [],
      bubbles: this.bubbles.map(B => ({ by: B.by, x: B.x, y: B.y, z: B.z, age: Date.now() - B.at })), dg: this.dg.state === 'ground' ? { x: this.dg.x, z: this.dg.z } : null });
    this.broadcast({ t: 'join', f: this.pub(f) }, f);
    this.report();
  }
  leave(f) {
    if (!this.f.has(f.id) || this.f.get(f.id) !== f) return;
    if (f.gun === 'gold' && f.alive) this.dropDeagle(f);
    this.f.delete(f.id); this.broadcast({ t: 'leave', id: f.id });
    if (!this.humans().length) { this.finish(true); return; }
    if (this.host === f.id) { this.host = this.humans().sort((a, b) => a.joinedAt - b.joinedAt)[0].id; this.broadcast({ t: 'host', id: this.host }); }
    if (this.phase === 'play') this.addBot(false);
    this.report();
  }
  finish(empty) {
    if (this.phase === 'closed') return;
    if (this.phase === 'play' && !empty) {
      this.phase = 'over';
      const st = [...this.f.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(f => ({ id: f.id, name: f.name, k: f.kills, d: f.deaths }));
      this.broadcast({ t: 'over', st });
      for (const h of this.humans()) this.send(h, { t: 'summary', earned: h.earned });
      this.closeAt = Date.now() + 15e3;
      this.report(true);
      return;
    }
    this.phase = 'closed'; clearInterval(this.timer);
    for (const h of this.humans()) { try { h.ws.close(1000, 'match over'); } catch {} }
    this.f.clear(); this.report(true);
  }

  // ---------- helpers ----------
  pub(f) { return { id: f.id, name: f.name, kind: f.kind, skill: f.skill, loadout: f.loadout, alive: f.alive, hp: f.hp, sh: f.sh, pk: f.pk, kills: f.kills, deaths: f.deaths,
    streak: f.streak, gun: f.gun, x: f.x, y: f.y, z: f.z, ssj: f.ssj }; }
  send(f, o) { if (f.ws) { try { f.ws.send(JSON.stringify(o)); } catch {} } }
  broadcast(o, except) { const s = JSON.stringify(o); for (const f of this.f.values()) if (f.ws && f !== except) { try { f.ws.send(s); } catch {} } }
  owns(f, by) { const t = this.f.get(by); return t && (by === f.id || (this.host === f.id && t.kind === 'b')) ? t : null; }
  dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  invulnerable(t, now) { return !t.alive || now < t.inv || t.striking; }

  spawn(f, silent) {
    const now = Date.now(), others = [...this.f.values()].filter(q => q !== f && q.alive);
    const sc = SPAWNS.map(s => ({ s, d: others.length ? Math.min(...others.map(q => Math.hypot(q.x - s[0], q.z - s[1]))) : Math.random() * 100 })).sort((a, b) => b.d - a.d);
    const s = sc[Math.floor(Math.random() * Math.min(3, sc.length))].s;
    Object.assign(f, { x: s[0] + rnd(-1, 1), y: 0, z: s[1] + rnd(-1, 1), alive: true, hp: 100, sh: 0, pk: 0, gun: STARTER, inv: now + SPAWN_INV_MS, striking: false, s: null });
    if (f.dstreak >= 3 && Math.random() < 0.6) { f.pk = 50; f.sh = 50; f.dstreak = 0; }
    if (!silent) this.broadcast({ t: 'spawn', id: f.id, x: f.x, z: f.z, hp: f.hp, sh: f.sh, pk: f.pk });
  }
  bubbleBetween(a, ay, b, by) {   // does a live shield's surface lie on the line between two points?
    const now = Date.now();
    for (const B of this.bubbles) { if (now - B.at > BUBBLE.lifeMs) continue;
      const dx = b.x - a.x, dy = by - ay, dz = b.z - a.z, L = Math.hypot(dx, dy, dz); if (L < 1e-3) continue;
      const ux = dx / L, uy = dy / L, uz = dz / L, ox = a.x - B.x, oy = ay - B.y, oz = a.z - B.z;
      const bb = ox * ux + oy * uy + oz * uz, c = ox * ox + oy * oy + oz * oz - BUBBLE.r * BUBBLE.r, disc = bb * bb - c; if (disc < 0) continue;
      const sq = Math.sqrt(disc), t1 = -bb - sq, t2 = -bb + sq;
      if ((t1 > 0 && t1 < L) || (t2 > 0 && t2 < L)) return true; }
    return false; }
  dropDeagle(f) {
    this.dg = { state: 'ground', holder: null, x: f.x, z: f.z, at: Date.now() };
    this.broadcast({ t: 'dg', state: 'ground', x: f.x, z: f.z });
  }
  damage(t, s, n, w, head, knock) {
    const now = Date.now(); if (this.invulnerable(t, now) || this.phase !== 'play') return;
    if (s && s.ssj) n = Math.round(n * SSJ_DMG);
    let rem = n;
    if (t.pk > 0) { const a = Math.min(t.pk, rem); t.pk -= a; t.sh -= a; rem -= a; }
    if (t.sh > 0 && rem > 0) { const a = Math.min(t.sh, rem); t.sh -= a; rem -= a; }
    t.hp -= rem;
    this.broadcast({ t: 'dmg', to: t.id, by: s ? s.id : null, n, hp: Math.max(0, t.hp), sh: t.sh, pk: t.pk, head: !!head, w, k: knock || null });
    if (t.hp <= 0) this.elim(t, s, w);
  }
  elim(t, s, w) {
    const now = Date.now();
    if (t.gun === 'gold') this.dropDeagle(t);
    Object.assign(t, { alive: false, deaths: t.deaths + 1, streak: 0, ssj: false, dstreak: t.dstreak + 1, respawnAt: now + RESPAWN_MS, hp: 0, sh: 0, pk: 0, strikeReady: false, striking: false });
    const killer = s && s !== t && this.f.get(s.id) === s ? s : null;
    if (killer) {
      killer.kills++; killer.streak++; killer.dstreak = 0;
      if (killer.alive) { const h = killer.ssj ? SSJ_HEAL : KILL_HEAL; killer.hp = Math.min(100, killer.hp + h); killer.sh = Math.min(100, killer.sh + h); }
    }
    this.broadcast({ t: 'elim', to: t.id, by: killer ? killer.id : null, w, k: killer ? killer.kills : 0, d: t.deaths, st: killer ? killer.streak : 0, hp: killer ? killer.hp : 0, sh: killer ? killer.sh : 0 });
    if (!killer) return;
    this.award(killer, KILL_BUCKS, '', true);
    const n = killer.streak;
    if (STREAK_BUCKS[n]) {
      this.award(killer, STREAK_BUCKS[n], n + ' streak');
      if (n === 5) killer.strikeReady = true;
      if (n === 7) this.rains.push({ owner: killer.id, until: now + 20e3, next: now + 500 });
      if (n === 10) { killer.ssj = true; killer.hp = 100; killer.sh = 100; }
      this.broadcast({ t: 'streak', id: killer.id, n, hp: killer.hp, sh: killer.sh });
    }
  }
  explode(x, y, z, owner, r, lo, hi, w, kind) {
    this.broadcast({ t: 'boom', x, y, z, kind, by: owner ? owner.id : null });
    for (const q of [...this.f.values()]) {
      if (q === owner || !q.alive) continue;
      const d = Math.hypot(q.x - x, q.y + 0.7 - y, q.z - z);
      if (d < r && !this.bubbleBetween({ x, z }, y, q, q.y + 0.8)) this.damage(q, owner, Math.round(lo + hi * (1 - d / r)), w, false);
    }
  }

  // ---------- messages from a player's browser ----------
  onMsg(f, m) {
    if (!this.f.has(f.id) || this.phase === 'closed') return;
    const now = Date.now();
    // flood guard: a normal client sends ~15 state updates plus shots per second
    if (now - (f.mWin || 0) > 1000) { f.mWin = now; f.mCount = 0; }
    if (++f.mCount > 90) { if (f.mCount > 400) { try { f.ws.close(1008, 'too many messages'); } catch {} } return; }
    switch (m.t) {
      case 's': this.state(f, m.s); break;                                     // my body: position, aim, animation flags
      case 'bs': if (this.host === f.id && Array.isArray(m.b)) for (const row of m.b.slice(0, 8)) { const b = this.f.get(row && row[0]); if (b && b.kind === 'b') this.state(b, row.slice(1)); } break;
      case 'shot': {
        const s = this.owns(f, m.by); if (!s || !s.alive || s.striking) return;
        const g = GUNS[s.gun]; if (!g || g.melee || now - s.lastShot < g.rate * 1000 * 0.7) return;
        s.lastShot = now;
        const mz = Array.isArray(m.m) ? m.m.slice(0, 3).map(v => fin(v, -400, 400)) : null, e = Array.isArray(m.e) ? m.e.slice(0, 3).map(v => fin(v, -400, 400)) : null;
        if (mz && e && !mz.includes(null) && !e.includes(null)) this.broadcast({ t: 'shot', by: s.id, gun: s.gun, m: mz, e }, f);
        const claims = g.pierce ? (Array.isArray(m.hits) ? m.hits.slice(0, g.pierce) : []) : (m.hit ? [m.hit] : []);
        for (const c of claims) { const hit = c && this.f.get(c.id);
          if (hit && hit !== s && this.dist(s, hit) <= g.rng + 8 && !this.bubbleBetween(s, s.y + 1.1, hit, hit.y + 0.9)) this.damage(hit, s, Math.round(g.dmg * (c.head ? 1.5 : 1)), g.name, !!c.head); }
        break; }
      case 'swing': {
        const s = this.owns(f, m.by); if (!s || !s.alive || s.gun !== 'flail' || now - s.lastSwing < GUNS.flail.rate * 1000 * 0.75) return;
        s.lastSwing = now; this.broadcast({ t: 'swing', by: s.id, dir: m.dir === -1 ? -1 : 1 }, f);
        for (const id of (Array.isArray(m.hits) ? m.hits.slice(0, 5) : [])) {
          const q = this.f.get(id); if (!q || q === s || this.dist(s, q) > GUNS.flail.reach + 2.5 || this.bubbleBetween(s, s.y + 0.8, q, q.y + 0.8)) continue;
          const dx = q.x - s.x || 0.01, dz = q.z - s.z, l = Math.hypot(dx, dz) || 1;
          this.damage(q, s, GUNS.flail.dmg, 'Flail', false, [dx / l, dz / l]);
        }
        break; }
      case 'surge': { const s = this.owns(f, m.by); if (s) this.broadcast({ t: 'surge', by: s.id }, f); break; }
      case 'pit': {
        const s = this.owns(f, m.by); if (!s || !s.alive) return;
        const x = fin(m.x, -HX, HX), z = fin(m.z, -HZ, HZ), yaw = fin(m.yaw, -100, 100);
        if (x === null || z === null || yaw === null || now - s.pitAt < PIT_CD_MS - 600 || Math.hypot(x - s.x, z - s.z) > 4) return;
        s.pitAt = now; const P = { by: s.id, x, z, yaw, at: now }; this.pits.push(P);
        this.broadcast({ t: 'pit', by: s.id, x, z, yaw });
        break; }
      case 'bubble': {
        const s = this.owns(f, m.by); if (!s || !s.alive || s.striking) return;
        const x = fin(m.x, -HX, HX), y = fin(m.y, -5, 40), z = fin(m.z, -HZ, HZ);
        if (x === null || y === null || z === null || now - (s.bubAt || -1e12) < BUBBLE.cdMs - 600 || Math.hypot(x - s.x, z - s.z) > 4) return;
        s.bubAt = now; this.bubbles.push({ by: s.id, x, y, z, at: now });
        this.broadcast({ t: 'bubble', by: s.id, x, y, z });
        break; }
      case 'pickdg': {   // grab the dropped Deagle
        const s = this.owns(f, m.by); if (!s || !s.alive || this.dg.state !== 'ground' || Math.hypot(this.dg.x - s.x, this.dg.z - s.z) > 2.6) return;
        this.dg = { state: 'held', holder: s.id }; s.gun = 'gold';
        this.broadcast({ t: 'dg', state: 'held', by: s.id });
        break; }
      case 'pick': {
        const s = this.owns(f, m.by), it = this.items[m.i | 0]; if (!s || !s.alive || !it || !it.avail || Math.hypot(it.x - s.x, it.z - s.z) > 2.6) return;
        if (it.kind === 'w') { if (it.key === s.gun) return; if (s.gun === 'gold') this.dropDeagle(s); s.gun = it.key; if (it.key === 'gold') this.dg = { state: 'held', holder: s.id }; }
        else if (it.key === 'med') { if (s.hp >= 100) return; s.hp = Math.min(100, s.hp + 50); }
        else if (it.key === 'shield') { if (s.sh >= 100) return; s.sh = Math.min(100, s.sh + 50); }
        it.avail = false; it.at = now + (it.kind === 'w' ? rnd(8e3, 12e3) : 14e3); const key = it.key;
        if (it.kind === 'w') it.key = pickGun(false);
        this.broadcast({ t: 'pick', by: s.id, i: it.i, key, hp: s.hp, sh: s.sh });
        break; }
      case 'strike': { const s = this.owns(f, m.by); if (!s) return;
        if (m.on && s.strikeReady && s.alive) { s.striking = true; s.strikeEnd = now + 15e3; this.broadcast({ t: 'strike', by: s.id, on: 1 }, f); }
        else if (!m.on && s.striking) { s.striking = false; s.inv = now + 1000; this.broadcast({ t: 'strike', by: s.id, on: 0 }, f); }
        break; }
      case 'boom': {   // a Stick Strike missile landed
        const s = this.owns(f, m.by); if (!s || !s.strikeReady) return;
        const x = fin(m.x, -HX - 5, HX + 5), y = fin(m.y, -5, 80), z = fin(m.z, -HZ - 5, HZ + 5); if (x === null || y === null || z === null) return;
        s.strikeReady = false; this.explode(x, y, z, s, 7.5, 20, 150, 'Stick Strike', 'strike');
        break; }
      case 'ping': this.send(f, { t: 'pong', c: m.c }); break;
    }
  }
  state(f, a) {
    if (!Array.isArray(a) || a.length < 9) return;
    const x = fin(a[0], -HX - 2, HX + 2), y = fin(a[1], -6, 90), z = fin(a[2], -HZ - 2, HZ + 2);
    if (x === null || y === null || z === null) return;
    const row = [x, y, z]; for (let i = 3; i < 8; i++) row.push(fin(a[i], -60, 60) ?? 0); row.push((a[8] | 0) & 0xffff);
    if (Array.isArray(a[9])) { const mm = a[9].slice(0, 6).map(v => fin(v, -400, 400)); if (!mm.includes(null)) row.push(mm); }   // strike missile in flight
    f.x = x; f.y = y; f.z = z; f.s = row;
  }

  // ---------- the clock ----------
  tick() {
    const now = Date.now();
    if (this.phase === 'over') { if (now >= this.closeAt) this.finish(true); return; }
    if (this.phase !== 'play') return;
    for (const f of this.f.values()) {
      if (!f.alive && now >= f.respawnAt) this.spawn(f, false);
      if (f.striking && now > f.strikeEnd) f.striking = false;
    }
    for (const it of this.items) if (!it.avail && now >= it.at) { if (it.key === 'gold' && this.dg.state !== 'pad') it.key = pickGun(false); it.avail = true; this.broadcast({ t: 'item', i: it.i, key: it.key }); }
    this.pits = this.pits.filter(p => now - p.at < 11e3);
    this.bubbles = this.bubbles.filter(B => now - B.at < BUBBLE.lifeMs);
    if (this.dg.state === 'ground' && now - this.dg.at > DEAGLE_RETURN_MS) {
      const pad = this.items.find(it => it.center); this.dg = { state: 'pad' };
      if (pad) { pad.key = 'gold'; pad.avail = true; this.broadcast({ t: 'dg', state: 'pad' }); this.broadcast({ t: 'item', i: pad.i, key: 'gold' }); } }
    // missile rain: the server picks the targets so every screen sees the same missiles
    for (const R of this.rains) {
      if (now >= R.next && now < R.until) {
        R.next = now + rnd(280, 450);
        const foes = [...this.f.values()].filter(q => q.id !== R.owner && q.alive && now >= q.inv);
        let x, z; if (foes.length && Math.random() < 0.75) { const q = pick(foes); x = q.x + rnd(-3, 3); z = q.z + rnd(-3, 3); } else { x = rnd(-HX + 2, HX - 2); z = rnd(-HZ + 2, HZ - 2); }
        x = Math.max(-HX + 1, Math.min(HX - 1, x)); z = Math.max(-HZ + 1, Math.min(HZ - 1, z));
        const dur = 1400, M = { id: ++this.seq, x, z, sx: x + rnd(-9, 9), sz: z + rnd(-9, 9), at: now + dur, owner: R.owner };
        this.missiles.push(M); this.broadcast({ t: 'missile', id: M.id, x, z, sx: M.sx, sz: M.sz, dur });
      }
    }
    this.rains = this.rains.filter(R => now < R.until);
    for (const M of this.missiles) if (now >= M.at) { M.done = true; this.explode(M.x, 0.2, M.z, this.f.get(M.owner) || null, 5.5, 15, 95, 'Missile Rain', 'rain'); }
    this.missiles = this.missiles.filter(M => !M.done);
    // 20 snapshots a second of everyone's body
    const rows = []; for (const f of this.f.values()) if (f.s) rows.push([f.id, ...f.s.slice(0, 9), f.alive ? 1 : 0, Math.max(0, f.hp), f.sh, f.gun, f.s[9] || 0]);
    this.broadcast({ t: 'snap', f: rows, tl: Math.max(0, this.endsAt - now) });
    if (now >= this.endsAt) this.finish(false);
  }
}
