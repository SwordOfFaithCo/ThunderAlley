# ThunderAlley online relay

Phones (Android and iPhone) connect **out** to this tiny server, so online play works on any home Wi-Fi or mobile data with no port forwarding. Players meet in rooms by a 5-letter code. One phone hosts the match. If it leaves or loses connection, the relay makes the longest-connected player the new host and the match continues.

There are no dependencies: plain Node.js 18+ (`node server.js`). `GET /` is a health check and `GET /rooms` lists public rooms.

## Free hosting on Render (from your phone's browser)
1. Put this project in your GitHub repo (`SwordOfFaithCo/ThunderAlley`).
2. Sign in at render.com with GitHub. Go to **New → Blueprint**, pick the repo, then **Apply**. `render.yaml` sets everything up: service `thunderalley-relay`, free plan, root `relay/`.
3. Your relay address is `wss://thunderalley-relay.onrender.com`, which the game uses by default. If Render gives you a different name, put it in **Settings → Gameplay → Online server (rooms)**.

On the free plan the server sleeps after 15 idle minutes. The first player to connect wakes it, which takes up to a minute (the game shows "Waking up the online server…"). It stays awake while anyone is playing.

## Accounts and cloud saves
The same server runs ThunderAlley accounts (`accounts.js`): claim a unique username, sign in, password recovery codes, change username/password, delete account, and a cloud save of level, XP, stats, campaign progress and loadouts. Passwords are hashed with scrypt, sessions are random tokens (stored hashed, 120 days), and sign-in, sign-up and recovery are rate-limited. In online rooms the relay checks each player's session and shows their real account name. A guest can't pose as a registered player: if a guest picks a claimed name, it gets a `*`.

**Storage.** Render's free disk is wiped every time the server restarts, so accounts need a free Upstash Redis database:
1. Sign up at upstash.com (free). Go to **Create Database**, pick any region near Render (for example us-east-1), and use the free plan.
2. On the database page, open **REST API** and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. On Render, open the `thunderalley-relay` service, go to **Environment**, add both values and save. The service redeploys.
4. Open `https://thunderalley-relay.onrender.com/`. It should say `accounts=upstash`.

Without those variables the server keeps accounts in `data/accounts.json`. That's fine on a VPS, but on Render it's lost on every restart. API reference: the comment at the top of `accounts.js`.

## Run anywhere else
`PORT=8080 node server.js` works on any VPS, including the Oracle Always Free VM from SERVER.md. Put it behind HTTPS (for example Caddy) so iPhones can use `wss://`.

## Store: Premium, Season Pass, tokens
`shop.js` sells Premium and the Season Pass, tracks pass XP and pass tokens per account, and takes payments through Stripe or Google Play. Seasons and prices are in `seasons.json`. Setup (Stripe keys, webhook, Google Play service account) is in `../SHOP_SETUP.md`. API reference: the comment at the top of `shop.js`.
