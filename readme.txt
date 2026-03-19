SCHOOL — Discord & Instagram on restricted networks
====================================================

FOR USERS
---------
1. Open index.html in your browser.
2. Pick Discord or Instagram.
3. Set a vault PIN (encrypts your credentials locally).
4. Enter your CORS proxy URL (default is provided).
5. Choose a login method:
   a) Browser Login: click "Find a Mirror" to auto-discover a
      streaming server, or paste a URL manually. Log in through
      the remote browser — your token is captured automatically.
   b) Token Login (Discord): paste your user token directly.
      Use the "Get Token / Session ID" button on the launcher
      to grab it via bookmarklet on discord.com.
   c) Session Login (Instagram): paste your sessionid cookie.
      Use the bookmarklet on instagram.com to grab it.
6. Done — your session is saved in your encrypted vault.

Your credentials never leave your browser. Everything is
encrypted with AES-256-GCM and locked behind your PIN.


GETTING YOUR TOKEN / SESSION ID (bookmarklets)
-----------------------------------------------
1. Open index.html and click "Get Token / Session ID".
2. Drag the bookmarklet button to your browser's bookmarks bar.
3. Visit discord.com or instagram.com (while logged in).
4. Click the bookmark — your token/sessionid is copied to
   clipboard automatically.
5. Paste it into the Token Login / Session Login tab.


SETTINGS (in-app gear icon)
----------------------------
- Root Server URL:  Backup mirror registry (e.g. http://pi:8090)
- Stream Timeout:   Seconds of inactivity before auto-disconnect
                    (default: 60, set 0 to disable)
- Auto-Refresh:     Poll interval for new messages (seconds)

Multi-tab: While streaming, click "+" to open additional tabs
in the remote browser. Click tab names to switch between them.


FOR HOSTERS — FROM SCRATCH
----------------------------
Host a mirror on any Linux/macOS machine in 5 minutes:

  Requirements: curl, 2 GB RAM, stable internet, any modern OS
  (Linux, macOS, WSL2, GitHub Codespaces, Raspberry Pi all work)

  Step 1 — Get a free ngrok account
    https://dashboard.ngrok.com/signup
    Copy your authtoken from: https://dashboard.ngrok.com/get-started/your-authtoken

  Step 2 — Clone the repo
    git clone https://github.com/mysiwn/school
    cd school

  Step 3 — Run the script
    sh contribute.sh
    (The script auto-installs Node.js 18+, Chromium, and ngrok)
    (You will be prompted for your ngrok authtoken on first run)

  Step 4 — Keep it running
    Leave the terminal open. Press Ctrl+C to stop.
    Your mirror URL is printed in the terminal.

  To run always-on in the background:
    screen -S mirror sh contribute.sh     # then Ctrl+A D to detach
    # or
    nohup sh contribute.sh > mirror.log 2>&1 &

  Pre-set your ngrok token to skip the prompt:
    NGROK_AUTHTOKEN=your_token sh contribute.sh

  Point to a backup registry:
    ROOT_SERVER=http://your-pi:8090 sh contribute.sh

  GitHub Codespaces (free, no machine needed):
    1. Fork the repo on GitHub
    2. Open a Codespace on your fork
    3. Run: sh codespaces.sh
    (Codespaces gives 60 free hours/month)


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
codespaces.sh        Codespaces entry point (git pull + contribute)

client/              Browser client code
  discord/           Discord client (HTML, JS, CSS)
  insta/             Instagram client (HTML, JS, CSS)
  shared/            Shared encryption & validation
  faq.html           FAQ & security info (also embedded in launcher)

server/              Server-side code
  worker.js          CORS proxy (Cloudflare Worker)
  playwright-server.js   Browser streaming server (multi-tab)
  root-server.js     Backup mirror registry for Pi
  playwright-login.js    Standalone login helper
  playwright.json    Mirror list
  package.json       Node dependencies
