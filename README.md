# Stick Pit — online edition

A free stick-figure shooter with **online matchmaking**, a **players-online counter**, a **global Stick Bucks leaderboard** and **server-dealt blackjack**, all running on Cloudflare's free plan.

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The game page people load. Built from `game/stick-pit.html`. |
| `game/stick-pit.html` | The game source. Edit this, then run `npm run build`. |
| `src/worker.js` | Web server: serves the page and routes `/api` and `/ws` traffic. Also holds the **Lobby**: accounts, Stick Bucks, leaderboard, online count, matchmaking, blackjack. |
| `src/match.js` | One **Match** room: health, damage, kills, streaks, pickups, respawns, clock and payouts. |
| `src/rules.js` | Weapon stats, map spots and payouts the server enforces (keep in sync with the game). |
| `src/blackjack.js` | Blackjack dealt on the server, so hands and winnings can't be edited in the browser. |
| `wrangler.jsonc` | Cloudflare config. The Worker is named `stick-pit`. |

## How it works

* **Accounts.** Players create a unique username and password on their first visit and can log in on any device. Passwords are stored only as salted PBKDF2 hashes, and they can't be recovered.
* **Saved to the account.** Stick Bucks, lifetime kills, owned items, what you're wearing, friends and parties are all saved.
* **Friends and parties.**
  * The Party tab lists everyone online. Invite anyone into a party of up to 6, or send them a friend request.
  * When the party leader presses Play, the whole party lands in the same match.
  * Empty party spots show as faint figures in the lobby.
* **Matchmaking.** Play joins the busiest running match with room for your whole party. Otherwise it opens a new match with bots in the empty slots, and the bots step aside as real players join.
* **The shop.** The Locker tab turns the lobby into the Stick Shop:
  * Pumpkin Head and Work Boots are free.
  * White Tee costs $20, Blue Jeans $50 and Baggy Neon Pants $10,000.
  * The Dog Tag unlocks at 50 lifetime FFA kills.
  * The server checks every purchase.
* **Who decides what.** Each browser runs its own player's movement and aim and reports its shots. The server checks every hit (weapon, fire rate, range, shields) and decides damage, kills, streaks, pickups and payouts.
* **Stick Bucks.** Kills pay $10. Streaks pay +$25, +$50, +$100 and +$1,000 at 3, 5, 7 and 10 kills. New accounts start with $100.
* **Offline.** If the page can't reach the server (for example, inside Claude), it runs the single-player version with bots, and the shop saves to that browser.

---

## Put it online: Option A, no installs (recommended)

You need a free **GitHub** account and a free **Cloudflare** account.

1. **Make a GitHub repository.** Go to <https://github.com/new>, name it `stick-pit` and click **Create repository**. Public or private both work.
2. **Upload the files.**
   1. On the new repo's page, click **uploading an existing file**.
   2. Drag in everything from this folder: `game`, `public`, `scripts`, `src`, `package.json`, `package-lock.json`, `wrangler.jsonc` and `README.md`.
   3. Click **Commit changes**.
   4. Don't upload `node_modules` or `.wrangler` if you have them.
3. **Make a Cloudflare account** at <https://dash.cloudflare.com/sign-up> and verify your email.
4. **Connect the repo.**
   1. In the Cloudflare dashboard, open **Workers & Pages**, click **Create**, then choose **Import a repository**. (If you don't see that option, use Option B below.)
   2. Connect your GitHub account and pick the `stick-pit` repo.
   3. Keep the project name **`stick-pit`**: it must match `name` in `wrangler.jsonc`.
   4. Leave the build command empty and keep the deploy command as `npx wrangler deploy`.
   5. Click **Deploy**.
5. **Open your game.** After about a minute, Cloudflare shows the address, e.g. `https://stick-pit.<your-name>.workers.dev`. Cloudflare may ask you to choose the `<your-name>` part the first time. The lobby shows **● 1 online** when the server is working.

From then on, every change you commit to the repo redeploys automatically.

## Put it online: Option B, command line

You need [Node.js 20+](https://nodejs.org).

```bash
npm install
npx wrangler login      # opens a browser to sign in to Cloudflare
npx wrangler deploy     # prints your https://stick-pit.<your-name>.workers.dev address
```

## Optional: your own domain

In Cloudflare, open **Workers & Pages → stick-pit → Settings → Domains & Routes → Add → Custom domain**. The domain has to be on your Cloudflare account. Buying one is optional and not free.

---

## Updating the game

1. Edit `game/stick-pit.html`.
2. Run `npm run build`, which regenerates `public/index.html`. Without Node, copy the new game file's contents into `public/index.html` after its first `<body>` line.
3. Commit (Option A) or run `npx wrangler deploy` (Option B).

If you change weapon damage or fire rates, map item spots or payouts in the game, change the same numbers in `src/rules.js`. The server enforces its copy.

## Test it on your own computer

```bash
npm install
npm run dev             # http://localhost:8787. Open it in two browser windows to play yourself.
```

## Free plan limits

* **Requests.** The free plan allows 100,000 requests a day. Incoming match messages are billed at 1 request per 20 messages; messages the server sends out are free.
* **Matches per day.** A full 3-minute match with 6 real players costs about 1,100 requests, so roughly 90 full matches a day. Matches that are mostly bots cost much less.
* **Lobby.** Idle lobby connections cost nothing while nobody is doing anything.
* **Running out.** Online play stops until the daily reset at midnight UTC. The **Workers Paid** plan (from $5/month) raises the limits.

## Cheating, honestly

The server owns damage, kills, Stick Bucks and blackjack, so nobody can edit their balance or fake a kill they couldn't have made. It can't stop someone running an aim-assist script in their own browser, though. To tighten that later, add line-of-sight checks to `src/match.js`.

## Resetting the leaderboard

Delete and redeploy the Worker (**Workers & Pages → stick-pit → Settings → Delete**). That wipes all accounts and balances.
