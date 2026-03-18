SCHOOL — Discord & Instagram on restricted networks
====================================================

FOR USERS
---------
1. Open index.html in your browser.
2. Pick Discord or Instagram.
3. Set a vault PIN (encrypts your credentials locally).
4. Enter your CORS proxy URL (default is provided).
5. Click "Find a Mirror" to auto-discover a server,
   or paste a mirror URL manually.
6. Log in through the remote browser stream.
7. Done — your session is saved in your encrypted vault.

Your credentials never leave your browser. Everything is
encrypted with AES-256-GCM and locked behind your PIN.


SETTINGS (in-app gear icon)
----------------------------
- Root Server URL:  Backup mirror registry (e.g. http://pi:8090)
- Stream Timeout:   Seconds of inactivity before auto-disconnect
                    (default: 60, set 0 to disable)
- Auto-Refresh:     Poll interval for new messages (seconds)

Multi-tab: While streaming, click "+" to open additional tabs
in the remote browser. Click tab names to switch between them.


FOR HOSTERS (contribute a mirror)
----------------------------------
1. Run:  bash contribute.sh
2. It handles everything automatically:
   - Installs Node.js, Chromium, and ngrok
   - Checks for ngrok auth — prompts for a free token if missing
     (get one at https://dashboard.ngrok.com/signup)
   - Starts the Playwright browser server (multi-tab enabled)
   - Opens an ngrok tunnel
   - Registers your mirror so users can find it
   - Heartbeats every 25 min to stay listed
3. Press Ctrl+C to stop.

Optional: set ROOT_SERVER env var to also register with a
backup mirror registry:
  ROOT_SERVER=http://your-pi:8090 bash contribute.sh

Requirements: Linux/macOS, curl, 2GB RAM, stable internet.


ROOT SERVER (for your Pi)
--------------------------
A lightweight backup mirror registry you run 24/7 on a Pi
(or any always-on machine). Mirrors register with it and
clients use it as fallback when the Cloudflare worker is down.

1. Run:  node server/root-server.js
   Or:   PORT=8090 node server/root-server.js
2. Set MIRROR_SECRET env var for authenticated registration.
3. Tell users to add the URL in Settings → Root Server URL.
4. Tell hosters to set ROOT_SERVER= when running contribute.sh.

The root server:
- Stores mirrors in memory + persists to mirrors-db.json
- Auto-prunes expired mirrors (30 min TTL for contributed)
- Health-checks all mirrors every 5 minutes
- No external dependencies (just Node.js)


PROJECT STRUCTURE
-----------------
index.html           Launcher — open this to use the app
contribute.sh        One-command mirror hosting

client/              Browser client code
  discord/           Discord client (HTML, JS, CSS)
  insta/             Instagram client (HTML, JS, CSS)
  shared/            Shared encryption & validation
  faq.html           FAQ & security info

server/              Server-side code
  worker.js          CORS proxy (Cloudflare Worker)
  playwright-server.js   Browser streaming server (multi-tab)
  root-server.js     Backup mirror registry for Pi
  playwright-login.js    Standalone login helper
  playwright.json    Mirror list
  package.json       Node dependencies
