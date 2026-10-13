// Game rules the server enforces. Keep in sync with GUNS / map data in public/index.html.
export const GUNS = {
  glock:  { name: 'Glock',        dmg: 30, rate: 0.20, rng: 90 },
  ak:     { name: 'AK-47',        dmg: 20, rate: 0.10, rng: 95 },
  sniper: { name: 'Sniper',       dmg: 95, rate: 1.15, rng: 240 },
  flail:  { name: 'Flail',        dmg: 55, rate: 0.80, rng: 0, reach: 3.8, melee: true },
  gold:   { name: 'Golden Glock', dmg: 85, rate: 0.32, rng: 140 },
};
export const STARTER = 'glock';
export const POOL = [['ak', 4.5], ['flail', 3], ['sniper', 2.2], ['gold', 0.6]];
export function pickGun(center) {
  if (center && Math.random() < 0.3) return 'gold';
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
