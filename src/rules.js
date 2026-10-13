// Game rules the server enforces. Keep in sync with GUNS / map data in public/index.html.
export const GUNS = {
  glock:  { name: 'Glock',        dmg: 30, rate: 0.20, rng: 90 },
  ak:     { name: 'AK-47',        dmg: 20, rate: 0.10, rng: 95 },
  sniper: { name: 'Sniper',       dmg: 95, rate: 1.15, rng: 240 },
  shotgun: { name: 'Sawed-Off',   dmg: 14, pellets: 9, rate: 0.3, mag: 2, reload: 1.7, rng: 30 },   // per pellet; full damage inside 7 m
  flail:  { name: 'Flail',        dmg: 55, rate: 0.80, rng: 0, reach: 3.8, melee: true },
  gold:   { name: 'Golden Deagle', dmg: 53, rate: 0.36, rng: 170, pierce: 4 },   // one per match; its fat round hits everyone in its path
};
export const STARTER = 'glock';
export const POOL = [['ak', 4.5], ['flail', 3], ['shotgun', 2.6]];
export function pickGun(center) {
  const t = POOL.reduce((s, p) => s + p[1], 0); let r = Math.random() * t;
  for (const [k, w] of POOL) { if ((r -= w) < 0) return k; }
  return 'ak';
}
export const HX = 45, HZ = 30;
export const ITEM_SPOTS = [[0,0,true],[-12,3.5],[12,-3.5],[0,-19],[0,19],[-24,-18],[24,18],[-38,-8],[38,8],[-38,22],[38,-22],[-16,22],[16,-22]];
export const POWER_SPOTS = [[-20,0,'med'],[20,0,'shield'],[-6,-10,'speed'],[6,10,'shield'],[-40,0,'speed'],[40,0,'med']];
export const SPAWNS = [[-40,-25],[40,25],[-40,25],[40,-25],[0,-27],[0,27],[-42,10],[42,-10],[-25,25],[25,-25]];
export const BOT_NAMES = ['xX_Blade_Xx','n00bslay3r','Zippy','MrBat','sk8r_ella','Vexx','lolcat99','Tanker','pwnstar','D4rkStick','Gh0stly','Hexxa'];
export const MATCH_MS = 180000, MAX_FIGHTERS = 6, RESPAWN_MS = 3000, SPAWN_INV_MS = 1600, PIT_CD_MS = 7000;
export const KILL_BUCKS = 10, STREAK_BUCKS = { 3: 25, 5: 50, 7: 100, 10: 1000 };
export const START_BUCKS = 100;

export function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').trim().slice(0, 14);
  return n || 'Player';
}
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = a => a[Math.floor(Math.random() * a.length)];

export const BUBBLE = { r: 2.5, lifeMs: 5000, cdMs: 12000 };   // shield bubble: 5 s, usable again 7 s after it pops
export const DEAGLE_RETURN_MS = 30000;                           // a dropped Deagle nobody grabs goes back to the center pad
export const SSJ_DMG = 1.3, SSJ_HEAL = 50, KILL_HEAL = 25;

// The shop. Prices in Stick Bucks; unlockKills = free once you have that many lifetime FFA kills.
export const SHOP = {
  pumpkin:   { slot: 'head',  name: 'Pumpkin Head',     price: 0 },
  boots:     { slot: 'feet',  name: 'Work Boots',       price: 0 },
  tee:       { slot: 'torso', name: 'White Tee',        price: 20 },
  jeans:     { slot: 'legs',  name: 'Blue Jeans',       price: 50 },
  neonpants: { slot: 'legs',  name: 'Baggy Neon Pants', price: 10000 },
  dogtag:    { slot: 'neck',  name: 'Dog Tag',          price: 0, unlockKills: 50 },
};
export const SLOTS = ['head', 'neck', 'torso', 'back', 'legs', 'feet'];
export const RESERVED = new Set(['admin', 'moderator', 'stickpit', 'system', 'player', 'you', 'bot', ...BOT_NAMES.map(n => n.toLowerCase())]);
export function checkUsername(n) {
  n = String(n || '').trim();
  if (n.length < 3 || n.length > 14) return 'Usernames are 3 to 14 characters';
  if (!/^[A-Za-z0-9_.-]+$/.test(n)) return 'Use letters, numbers, dots, dashes or underscores';
  if (RESERVED.has(n.toLowerCase())) return 'That name is reserved';
  return null;
}
