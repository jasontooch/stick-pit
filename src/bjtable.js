// Group blackjack: one table per party (or per solo player), one shared dealer hand for every seat.
// Pure state machine; the lobby object owns persistence, money and timers.
//   bet  -> first bet starts a 10 s window; anyone who hasn't bet when it closes sits the hand out
//   play -> seats act in order, 10 s each (a timeout stands), the house bot plays itself
//   done -> results stay up for a few seconds, then the next round opens for bets
import { MIN_BET, MAX_BET } from './blackjack.js';

export const BET_MS = 10000, TURN_MS = 10000, BOT_MS = 1100, DEAL_MS = 2200, DONE_MS = 5500, MAX_SEATS = 7;
export const BOT = { uid: 'bot', name: 'Lucky Larry', loadout: { head: 'pumpkin', torso: 'tee', feet: 'boots', legs: 'jeans' }, bot: true };

const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function newShoe() {
  const s = [];
  for (let d = 0; d < 6; d++) for (const su of SUITS) for (const r of RANKS) s.push(r + '|' + su);
  const a = new Uint32Array(s.length); crypto.getRandomValues(a);
  for (let i = s.length - 1; i > 0; i--) { const j = a[i] % (i + 1); [s[i], s[j]] = [s[j], s[i]]; }
  return s;
}
const val = c => { const r = c.split('|')[0]; return r === 'A' ? 11 : (r === 'J' || r === 'Q' || r === 'K' || r === '10') ? 10 : +r; };
export function total(h) { let t = 0, a = 0; for (const c of h) { if (c === 'down') continue; t += val(c); if (c.startsWith('A|')) a++; } while (t > 21 && a) { t -= 10; a--; } return t; }
const isBJ = h => h.length === 2 && total(h) === 21;
function draw(t) { if (t.shoe.length < 30) t.shoe = newShoe(); return t.shoe.pop(); }
const mkSeat = p => ({ uid: p.uid, name: p.name, loadout: p.loadout || {}, bot: !!p.bot, bet: 0, hand: [], doubled: false, st: 'idle', res: null, net: 0, gone: false });
const humans = t => t.seats.filter(s => !s.bot && !s.gone);

export function create(id) {
  return { id, round: 1, phase: 'bet', deadline: 0, shoe: newShoe(), dealer: [], seats: [mkSeat(BOT)], turn: -1, msg: 'Place your bets', ev: 0 };
}
const say = (t, msg) => { t.msg = msg; t.ev++; };

export function join(t, p) {
  const cur = t.seats.find(s => s.uid === p.uid);
  if (cur) { cur.gone = false; cur.name = p.name; cur.loadout = p.loadout || {}; return; }
  if (t.seats.length >= MAX_SEATS) {   // the bot gives up its stool for a real player when it isn't mid-hand
    const b = t.seats.findIndex(s => s.bot && (t.phase !== 'play' || !s.hand.length));
    if (b < 0) return 'The table is full';
    t.seats.splice(b, 1); if (t.turn > b) t.turn--;
  }
  const s = mkSeat(p); s.st = t.phase === 'bet' ? 'idle' : 'out';
  const b = t.seats.findIndex(x => x.bot);   // humans sit before the bot
  if (b >= 0 && !(t.phase === 'play' && t.turn >= b)) { t.seats.splice(b, 0, s); if (t.turn >= b) t.turn++; } else t.seats.push(s);
  say(t, `${p.name} sat down`);
}

// give(uid, n) returns money to a player's bank
export function leave(t, uid, now, give) {
  const i = t.seats.findIndex(s => s.uid === uid); if (i < 0) return;
  const s = t.seats[i];
  if (t.phase === 'bet' || !s.hand.length) {
    if (s.bet && t.phase === 'bet') give(uid, s.bet);
    t.seats.splice(i, 1); if (t.turn > i) t.turn--;
  } else {
    s.gone = true;
    if (t.phase === 'play' && t.turn === i && s.st === 'play') { s.st = 'stand'; nextTurn(t, now, i, give); }
  }
  if (!humans(t).length) t.empty = true;
  else if (t.phase === 'bet' && humans(t).every(x => x.st === 'bet')) deal(t, now, give);
}

// take(uid, n) removes money from a bank, returning false when there isn't enough
export function bet(t, uid, amt, now, take, give) {
  if (t.phase !== 'bet') return 'Wait for the next hand';
  const s = t.seats.find(x => x.uid === uid && !x.gone); if (!s) return 'Sit down first';
  amt = Math.floor(Number(amt));
  if (!(amt >= MIN_BET)) return `Minimum bet is $${MIN_BET}`;
  if (amt > MAX_BET) return `Maximum bet is $${MAX_BET}`;
  if (s.bet) give(uid, s.bet);   // changing your bet
  if (!take(uid, amt)) { if (s.bet) take(uid, s.bet); return 'Not enough Stick Bucks'; }
  s.bet = amt; s.st = 'bet';
  const bot = t.seats.find(x => x.bot); if (bot && !bot.bet) { bot.bet = [10, 25, 25, 50, 100][Math.floor(Math.random() * 5)]; bot.st = 'bet'; }
  if (!t.deadline) t.deadline = now + BET_MS;
  const wait = humans(t).filter(x => x.st !== 'bet');
  if (!wait.length) deal(t, now, give);
  else say(t, `${s.name} bet $${amt} · waiting on ${wait.map(x => x.name).join(', ')}`);
  return null;
}

function deal(t, now, give) {
  const sitting = humans(t).filter(s => s.st !== 'bet');
  for (const s of t.seats) { s.hand = []; s.res = null; s.net = 0; s.doubled = false; s.st = s.bet > 0 && !s.gone ? 'play' : 'out'; }
  const inn = t.seats.filter(s => s.st === 'play');
  if (!inn.some(s => !s.bot)) { for (const s of t.seats) { if (s.bot) { s.bet = 0; } s.st = 'idle'; } t.deadline = 0; say(t, 'Place your bets'); return; }
  t.dealer = [];
  for (let k = 0; k < 2; k++) { for (const s of inn) s.hand.push(draw(t)); t.dealer.push(draw(t)); }
  t.phase = 'play';
  for (const s of inn) if (isBJ(s.hand)) s.st = 'bj';
  const up = t.dealer[0], peek = up.startsWith('A|') || val(up) === 10;
  say(t, sitting.length ? `Dealing · ${sitting.map(s => s.name).join(', ')} sat out` : 'Dealing');
  if (peek && isBJ(t.dealer)) { finish(t, now + DEAL_MS, give); return; }
  nextTurn(t, now + DEAL_MS, -1, give);
}

function nextTurn(t, now, from, give) {
  for (let i = from + 1; i < t.seats.length; i++) {
    const s = t.seats[i];
    if (s.st !== 'play') continue;
    if (s.gone) { s.st = 'stand'; continue; }
    t.turn = i; t.deadline = now + (s.bot ? BOT_MS : TURN_MS);
    say(t, `${s.name}'s turn`);
    return;
  }
  finish(t, now, give);
}

export function act(t, uid, a, now, take, give) {
  if (t.phase !== 'play' || t.turn < 0) return 'No hand in progress';
  const s = t.seats[t.turn];
  if (!s || s.uid !== uid) return "It's not your turn";
  if (now < t.deadline - TURN_MS) return 'Cards are still coming out';
  return play(t, s, a, now, take, give);
}
function play(t, s, a, now, take, give) {
  if (a === 'hit') {
    s.hand.push(draw(t)); const v = total(s.hand);
    if (v > 21) { s.st = 'bust'; say(t, `${s.name} busts with ${v}`); }
    else if (v === 21) s.st = 'stand';
    if (s.st === 'play') { t.deadline = now + (s.bot ? BOT_MS : TURN_MS); say(t, `${s.name} hits · ${v}`); }
    else nextTurn(t, now + 500, t.turn, give);
    return null;
  }
  if (a === 'stand') { s.st = 'stand'; say(t, `${s.name} stands on ${total(s.hand)}`); nextTurn(t, now, t.turn, give); return null; }
  if (a === 'double') {
    if (s.hand.length !== 2) return 'You can only double on your first two cards';
    if (!s.bot && !take(s.uid, s.bet)) return 'Not enough Stick Bucks to double';
    s.bet *= 2; s.doubled = true; s.hand.push(draw(t));
    const v = total(s.hand); s.st = v > 21 ? 'bust' : 'stand';
    say(t, `${s.name} doubles · ${v}${v > 21 ? ' bust' : ''}`);
    nextTurn(t, now + 500, t.turn, give); return null;
  }
  return 'Unknown action';
}

function finish(t, now, give) {
  const live = t.seats.filter(s => s.st === 'stand');
  if (live.length) while (total(t.dealer) < 17) t.dealer.push(draw(t));
  const d = total(t.dealer), dB = isBJ(t.dealer);
  for (const s of t.seats) {
    if (!['stand', 'bust', 'bj', 'play'].includes(s.st) || !s.bet) continue;
    const p = total(s.hand), pB = isBJ(s.hand) && !s.doubled;
    let pay = 0, res;
    if (pB && !dB) { pay = s.bet * 2.5; res = 'bj'; }
    else if (pB && dB) { pay = s.bet; res = 'push'; }
    else if (dB) res = 'lose';
    else if (p > 21) res = 'lose';
    else if (d > 21 || p > d) { pay = s.bet * 2; res = 'win'; }
    else if (p === d) { pay = s.bet; res = 'push'; }
    else res = 'lose';
    pay = Math.floor(pay); s.res = res; s.net = pay - s.bet;
    if (pay && !s.bot) give(s.uid, pay);
  }
  t.phase = 'done'; t.turn = -1;
  t.deadline = now + DONE_MS + Math.max(0, t.dealer.length - 2) * 600;
  say(t, dB ? 'Dealer blackjack' : d > 21 ? `Dealer busts with ${d}` : `Dealer has ${d}`);
}

function nextRound(t) {
  t.seats = t.seats.filter(s => !s.gone);
  for (const s of t.seats) Object.assign(s, { bet: 0, hand: [], doubled: false, st: 'idle', res: null, net: 0 });
  if (!t.seats.some(s => s.bot) && t.seats.length < MAX_SEATS) t.seats.push(mkSeat(BOT));
  t.dealer = []; t.phase = 'bet'; t.deadline = 0; t.turn = -1; t.round++;
  if (!humans(t).length) t.empty = true;
  say(t, 'Place your bets');
}

// Called when the deadline passes. Returns true if anything changed.
export function tick(t, now, take, give) {
  if (!t.deadline || now < t.deadline) return false;
  if (t.phase === 'bet') { deal(t, now, give); return true; }
  if (t.phase === 'play') {
    const s = t.seats[t.turn]; if (!s) { finish(t, now, give); return true; }
    if (s.bot) play(t, s, total(s.hand) < 17 ? 'hit' : 'stand', now, take, give);
    else { s.st = 'stand'; say(t, `${s.name} ran out of time · standing on ${total(s.hand)}`); nextTurn(t, now, t.turn, give); }
    return true;
  }
  if (t.phase === 'done') { nextRound(t); return true; }
  return false;
}

export function view(t, now) {
  const hide = t.phase === 'play';
  return {
    id: t.id, round: t.round, phase: t.phase, ev: t.ev, msg: t.msg,
    left: t.deadline ? Math.max(0, t.deadline - now) : 0,
    turn: t.turn >= 0 && t.seats[t.turn] ? t.seats[t.turn].uid : null,
    dealer: t.dealer.map((c, i) => (hide && i === 1 ? 'down' : c)),
    dealerTotal: total(t.dealer.map((c, i) => (hide && i === 1 ? 'down' : c))),
    seats: t.seats.map(s => ({ uid: s.uid, name: s.name, loadout: s.loadout, bot: s.bot, bet: s.bet, hand: s.hand, st: s.st, res: s.res, net: s.net, doubled: s.doubled, gone: s.gone, total: total(s.hand) })),
  };
}
