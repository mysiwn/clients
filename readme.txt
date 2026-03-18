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


FOR HOSTERS (contribute a mirror)
----------------------------------
1. Run:  bash contribute.sh
2. It handles everything automatically:
   - Installs Node.js, Chromium, and ngrok
   - Checks for ngrok auth — prompts for a free token if missing
     (get one at https://dashboard.ngrok.com/signup)
   - Starts the Playwright browser server
   - Opens an ngrok tunnel
   - Registers your mirror so users can find it
   - Heartbeats every 25 min to stay listed
3. Press Ctrl+C to stop.

That's it. Your machine becomes a mirror that anyone can
use to log in through "Find a Mirror" in the client.

Requirements: Linux/macOS, curl, 2GB RAM, stable internet.


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
  playwright-server.js   Browser streaming server
  playwright-login.js    Standalone login helper
  playwright.json    Mirror list
  package.json       Node dependencies
