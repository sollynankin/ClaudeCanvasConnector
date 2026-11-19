# Canvas Library

Add your Canvas course modules to a private library on **your own computer**, then ask Claude about
them: summaries, quizzes, "where did the lecturer explain X?", exam prep.

- A **Chrome extension** copies the modules you pick (pages, assignments, files, slides, PDFs) into a folder on your PC.
- A small **connector** (an MCP server) lets Claude browse and search that folder.
- Free, open source, and nothing is uploaded anywhere. No account, no API token, no subscription.

```
Canvas ──(extension, uses your login)──> library folder on your PC <── connector <── Claude
```

> Not affiliated with Instructure (Canvas), Anthropic or any university. For personal study use only;
> see [Responsible use](#responsible-use).

---

## What you need

| | |
| --- | --- |
| **Claude** | The Claude desktop app ([download](https://claude.ai/download)) or Claude Code. A free or paid account both work. |
| **A Chromium browser** | Chrome, Edge, Brave or Arc, logged in to your Canvas. |
| **Node.js 20+** | [nodejs.org](https://nodejs.org), pick the LTS version. Check with `node -v` in a terminal. |
| **Git** (optional) | To download and update easily. Otherwise use GitHub's *Code → Download ZIP*. |

Works on Windows, macOS and Linux.

---

## Setup (about 5 minutes)

### 1. Get the code and install it

Open a terminal (PowerShell on Windows, Terminal on macOS) and run:

```bash
git clone https://github.com/<your-github-username>/canvas-library.git
cd canvas-library
npm install
```

No git? Download the ZIP from GitHub, unzip it, open a terminal inside that folder, and run `npm install`.

### 2. Install the Chrome extension

1. In your browser, open `chrome://extensions` (Edge: `edge://extensions`).
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the **`extension`** folder inside `canvas-library`.
4. Optional: click the puzzle-piece icon in the toolbar and pin **Canvas Library**.

> Run `npm run setup` any time to see these steps with the exact folder path for your computer.

### 3. Connect it to Claude

**Claude desktop app (recommended)**: from the `canvas-library` folder run

```bash
npm run setup:desktop
```

This adds Canvas Library to the app's settings (and saves a backup first). Then **fully quit Claude**
(Windows: tray icon → Quit; macOS: Claude menu → Quit) and open it again.

**Claude Code (terminal)**: `npm run setup` prints a ready-to-paste command that looks like:

```bash
claude mcp add canvas-library --scope user -- node /full/path/to/canvas-library/server/mcp.js
```

### 4. Check everything

```bash
npm run doctor
```

You should see green ticks for Node, dependencies, the extension folder and the Claude app.
(The "server is running" line only turns green while Claude is open. That's normal.)

---

## Using it

### Add a course or module

1. **Log in to Canvas** in your browser and open any page of a course (the URL contains `/courses/…`).
2. Click the **Canvas Library** extension icon.
3. Tick the modules you want, leave **Also download files** on, and press **Add … to library**.
4. Wait for the green "Added" message. Big courses with lots of slides can take a minute.

On a course's **Modules** page you'll also see a **+ Library** button on each module for one-click adds.
Modules you've already added are marked *in library*; adding one again refreshes it (unchanged files
aren't downloaded twice).

> The **library server has to be running** while you add things. It starts by itself whenever Claude
> has the connector enabled, so just have Claude open. If you want to add modules without Claude open,
> run `npm run server` in the `canvas-library` folder and leave that window open.

### Ask Claude

Start a **new chat** in the Claude app and try:

- *"List my Canvas library courses."*
- *"Summarise week 3 of Cell Biology from my library."*
- *"Search my library for 'Krebs cycle' and explain it using my lecture slides."*
- *"Quiz me on the Week 2 module, one question at a time."*
- *"Which assignments are due soon, and what does the rubric ask for?"*

Claude can use five tools: `list_courses`, `list_modules`, `get_module`, `read`, `search`.

### Browse or delete what's saved

Open <http://127.0.0.1:47821> in your browser (while the server is running) to look through the
library and remove modules or courses you no longer want.

### Update to a new version

```bash
git pull
npm install
```

Then click the reload icon on the extension's card in `chrome://extensions`, and restart Claude.

---

## What gets saved

Pages, assignments (due date, points, rubric), discussion prompts, quiz descriptions, external links
and files, including files linked from inside pages. Text is extracted from PDF, DOCX, PPTX (slides and
speaker notes), XLSX and plain-text files so Claude can search it. The original files are kept too, so
Claude can open images or scanned PDFs itself. Files over 100 MB are skipped.

Canvas doesn't expose: quiz questions you haven't attempted, video contents, or anything your account
can't open. Those show up as a warning on the item.

Everything lives in the `library/` folder next to the code. Delete a module in the web page above, or
delete the folder to wipe it all.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Popup says **server offline** | Open the Claude app (it starts the server), or run `npm run server` and leave it open. |
| Popup says "Open a Canvas course page" | Go to a page whose address contains `/courses/<number>`, then **reload the tab once** so the extension attaches, and click the icon again. |
| Canvas logs you out / asks for login | Log in again in that tab, then retry. The extension uses whatever session the tab has. |
| Claude doesn't list the Canvas Library tools | Fully **quit** Claude (tray/menu-bar icon → Quit), reopen, start a **new** chat. Run `npm run doctor`. In the app: Settings → Developer shows the connector's status and log. |
| `claude_desktop_config.json` errors | `npm run setup:desktop` refuses to touch a broken config. Fix or delete the file, or restore the `.bak-before-canvas-library` backup next to it. |
| Some files say "not downloaded" | Large files, or files your course locks. The text of the pages is still saved. Re-add the module later to retry. |
| A module is missing items | Items hidden or locked for students aren't readable via Canvas. Check the warnings shown on the item in Claude or in the library page. |
| Port 47821 is already in use | Something else is using it, or the server is already running (which is fine). To change it set `CANVAS_LIBRARY_PORT` and update `SERVER` in `extension/background.js` and `extension/popup.js`, and `host_permissions` in `extension/manifest.json`. |
| Works on my friend's laptop but not mine | Run `npm run doctor` and compare. Most often it's an old Node version (`node -v` must be 20+). |

Still stuck? Open an issue with the output of `npm run doctor`.

---

## Privacy and security

- Everything stays on your computer. The extension talks to a server on `127.0.0.1` only; there is no cloud, analytics or account.
- The server rejects requests from ordinary websites and from other computers. Only the extension and the app's own pages can use it.
- Claude receives the text of items **you ask about** as part of your chat, so your normal Claude privacy settings apply to those.
- The extension asks for access to `https://*/courses/*` so it works on any university's Canvas address. It does nothing unless the page answers Canvas's API, and it doesn't read other sites.
- No Canvas passwords or API tokens are used or stored. File download links with access tokens are not saved.

## Responsible use

Use this for your **own** studying, with courses you're enrolled in. Course material is usually the
lecturer's or university's copyright: don't share your `library/` folder, upload it publicly, or use it
in ways your university's rules forbid. Check your institution's policy on AI tools and on copying
course content. You're responsible for how you use it.

---

## For developers

```bash
npm test          # mock Canvas -> real crawler -> ingest server -> MCP over stdio (24 checks)
npm run server    # standalone ingest/management server
npm run mcp       # MCP server (stdio), also starts the ingest server when the port is free
```

| Path | What it is |
| --- | --- |
| `extension/` | Manifest V3 extension: `crawler.js` (Canvas API + import logic, also runs in Node for tests), `content.js`, `popup.*`, `background.js` |
| `server/library.js` | On-disk storage, text lookup and search |
| `server/extract.js` | PDF / DOCX / PPTX / XLSX text extraction |
| `server/http.js`, `ui.html` | Local ingest API and the browse/delete page |
| `server/mcp.js` | The MCP tools |

Config: `CANVAS_LIBRARY_DIR` (default `./library`), `CANVAS_LIBRARY_PORT` (default `47821`).

Pull requests welcome. Licence: [MIT](LICENSE).
