// Server-dealt blackjack: the shoe, the hole card and the payout never leave the server,
// so a player can only see what the table shows and can't edit their winnings.
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
export const MIN_BET = 10, MAX_BET = 100000;

function newShoe() {
  const s = [];
  for (let d = 0; d < 6; d++) for (const su of SUITS) for (const r of RANKS) s.push(r + '|' + su);
  const a = new Uint32Array(s.length); crypto.getRandomValues(a);
  for (let i = s.length - 1; i > 0; i--) { const j = a[i] % (i + 1); [s[i], s[j]] = [s[j], s[i]]; }
  return s;
}
const val = c => { const r = c.split('|')[0]; return r === 'A' ? 11 : (r === 'J' || r === 'Q' || r === 'K' || r === '10') ? 10 : +r; };
export function total(h) { let t = 0, a = 0; for (const c of h) { t += val(c); if (c.startsWith('A|')) a++; } while (t > 21 && a) { t -= 10; a--; } return t; }
const isBJ = h => h.length === 2 && total(h) === 21;

export function fresh() { return { shoe: newShoe(), phase: 'bet', bet: 0, player: [], dealer: [], doubled: false, result: null }; }
function draw(s) { if (s.shoe.length < 20) s.shoe = newShoe(); return s.shoe.pop(); }

// Returns {state, bank, error}
export function act(s, bank, action, bet) {
  s = s && s.shoe ? s : fresh();
  const err = e => ({ state: s, bank, error: e });
  if (action === 'state') return { state: s, bank };
  if (action === 'deal') {
    if (s.phase === 'player' || s.phase === 'dealer') return err('Hand in progress');
    bet = Math.floor(Number(bet));
    if (!(bet >= MIN_BET)) return err(`Minimum bet is $${MIN_BET}`);
    if (bet > MAX_BET) return err(`Maximum bet is $${MAX_BET}`);
    if (bet > bank) return err('Not enough Stick Bucks');
    bank -= bet;
    Object.assign(s, { phase: 'player', bet, player: [], dealer: [], doubled: false, result: null });
    s.player.push(draw(s)); s.dealer.push(draw(s)); s.player.push(draw(s)); s.dealer.push(draw(s));
    const up = s.dealer[0], peek = up.startsWith('A|') || val(up) === 10;
    if (isBJ(s.player) || (peek && isBJ(s.dealer))) return settle(s, bank);
    return { state: s, bank };
  }
  if (s.phase !== 'player') return err('No hand in progress');
  if (action === 'hit') {
    s.player.push(draw(s));
    const t = total(s.player);
    if (t > 21) return settle(s, bank);
    if (t === 21) return dealerPlay(s, bank);
    return { state: s, bank };
  }
  if (action === 'stand') return dealerPlay(s, bank);
  if (action === 'double') {
    if (s.player.length !== 2) return err('You can only double on your first two cards');
    if (bank < s.bet) return err('Not enough Stick Bucks to double');
    bank -= s.bet; s.bet *= 2; s.doubled = true;
    s.player.push(draw(s));
    return total(s.player) > 21 ? settle(s, bank) : dealerPlay(s, bank);
  }
  return err('Unknown action');
}
function dealerPlay(s, bank) { while (total(s.dealer) < 17) s.dealer.push(draw(s)); return settle(s, bank); }
function settle(s, bank) {
  const p = total(s.player), d = total(s.dealer), pB = isBJ(s.player) && !s.doubled, dB = isBJ(s.dealer);
  let pay = 0, msg, cls;
  if (pB && !dB) { pay = s.bet * 2.5; msg = 'Blackjack! Paid 3 to 2'; cls = 'win'; }
  else if (pB && dB) { pay = s.bet; msg = 'Both blackjack · push'; cls = 'push'; }
  else if (dB) { msg = 'Dealer blackjack'; cls = 'lose'; }
  else if (p > 21) { msg = 'Bust'; cls = 'lose'; }
  else if (d > 21) { pay = s.bet * 2; msg = 'Dealer busts · you win'; cls = 'win'; }
  else if (p > d) { pay = s.bet * 2; msg = `You win ${p} to ${d}`; cls = 'win'; }
  else if (p === d) { pay = s.bet; msg = `Push at ${p}`; cls = 'push'; }
  else { msg = `Dealer wins ${d} to ${p}`; cls = 'lose'; }
  pay = Math.floor(pay); bank += pay;
  s.result = { msg, cls, net: pay - s.bet, bj: pB && !dB };
  s.phase = 'done';
  return { state: s, bank };
}
// What the client may see: the hole card stays hidden until the hand is over.
export function view(s) {
  if (!s || !s.shoe) s = fresh();
  const hide = s.phase === 'player';
  return { phase: s.phase, bet: s.bet, player: s.player, dealer: s.dealer.map((c, i) => (hide && i === 1 ? 'down' : c)), doubled: s.doubled, result: s.result };
}
