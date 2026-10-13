// Wraps the game (game/stick-pit.html) into the full web page the site serves (public/index.html).
// Run after editing the game:  npm run build
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const game = readFileSync(new URL('game/stick-pit.html', root), 'utf8');
const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2313151d'/%3E" +
  "%3Cg stroke='%23ff8a2a' stroke-width='5' stroke-linecap='round' fill='none'%3E%3Ccircle cx='32' cy='15' r='7' fill='%23ff8a2a'/%3E" +
  "%3Cpath d='M32 22v18M32 40l-9 14M32 40l9 14M32 28l-11 7M32 28l12-4'/%3E%3C/g%3E%3C/svg%3E";
const head = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta name="description" content="Stick Pit: a free stick-figure shooter. Dig pits, chain killstreaks, play blackjack with Stick Bucks.">' +
  `<link rel="icon" href="${icon}">` +
  '<style>:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;padding:0}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
writeFileSync(new URL('public/index.html', root), head + game + '\n</body></html>\n');
console.log('wrote public/index.html');
