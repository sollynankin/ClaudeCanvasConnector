#!/usr/bin/env node
// Friendly setup helper.
//   npm run setup            show the exact steps and paths for this computer
//   npm run setup:desktop    add Canvas Library to the Claude desktop app (makes a backup first)
//   npm run doctor           check that everything is in place
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'server', 'mcp.js');
const EXT = path.join(ROOT, 'extension');
const PORT = Number(process.env.CANVAS_LIBRARY_PORT || 47821);
const entry = { command: process.execPath, args: [MCP] };

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function desktopConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= 20, text: `Node.js ${process.versions.node}` };
}

function checkDeps() {
  return { ok: fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol')), text: 'dependencies installed (npm install)' };
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function doctor() {
  console.log(bold('\nCanvas Library check\n'));
  const rows = [];
  const node = checkNode();
  rows.push([node.ok, node.text + (node.ok ? '' : ' — please install Node.js 20 or newer from https://nodejs.org')]);
  const deps = checkDeps();
  rows.push([deps.ok, deps.text + (deps.ok ? '' : ' — run: npm install')]);
  rows.push([fs.existsSync(path.join(EXT, 'manifest.json')), `extension folder found: ${EXT}`]);

  let desktop = 'not found';
  try {
    const cfg = readConfig(desktopConfigPath());
    if (!cfg) desktop = 'Claude desktop config not found (is the desktop app installed?)';
    else if (cfg.mcpServers?.['canvas-library']) {
      const same = path.resolve(cfg.mcpServers['canvas-library'].args?.[0] || '') === MCP;
      desktop = same ? 'ok' : `registered, but points to a different folder: ${cfg.mcpServers['canvas-library'].args?.[0]}`;
    } else desktop = 'not registered yet — run: npm run setup:desktop';
  } catch (e) {
    desktop = `could not read config: ${e.message}`;
  }
  rows.push([desktop === 'ok', `Claude desktop app: ${desktop === 'ok' ? 'registered' : desktop}`]);

  const up = await ping();
  rows.push([up, up ? `library server is running on port ${PORT}` : `library server is not running on port ${PORT} (it starts automatically when Claude uses the connector, or run: npm run server)`]);
  for (const [ok, text] of rows) console.log(`  ${ok ? green('✔') : red('✘')} ${text}`);
  console.log(dim('\nThe Chrome extension and Claude Code can only be checked by you: see README.md.\n'));
}

function addToDesktop() {
  const file = desktopConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    console.error(red(`\nCould not find the Claude desktop app's settings folder:\n  ${dir}\nInstall Claude desktop first (https://claude.ai/download), open it once, then run this again.\n`));
    process.exit(1);
  }
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = readConfig(file);
    } catch (e) {
      console.error(red(`\nYour Claude config is not valid JSON, so I won't touch it:\n  ${file}\n${e.message}\n`));
      process.exit(1);
    }
    fs.copyFileSync(file, `${file}.bak-before-canvas-library`);
    console.log(dim(`Backup saved: ${file}.bak-before-canvas-library`));
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), 'canvas-library': entry };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(green('\n✔ Added Canvas Library to the Claude desktop app.'));
  console.log(`  ${file}`);
  console.log(bold('\nNow fully quit Claude (tray / menu-bar icon → Quit) and open it again, then start a new chat.\n'));
}

function showSteps() {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  console.log(`
${bold('Canvas Library — setup for this computer')}

${bold('1. Install the Chrome extension')}  (works in Chrome, Edge, Brave, Arc)
   • Open  chrome://extensions  and switch on ${bold('Developer mode')} (top right)
   • Click ${bold('Load unpacked')} and choose this folder:
       ${EXT}

${bold('2. Connect it to Claude')}
   Claude desktop app (recommended):
       npm run setup:desktop
   then fully quit and reopen Claude.

   Claude Code (terminal):
       claude mcp add canvas-library --scope user -- ${q(process.execPath)} ${q(MCP)}

${bold('3. Add your courses')}
   • Log in to Canvas, open a course, click the extension icon, tick modules, press "Add to library".

${bold('4. Ask Claude')}
   • Start a new chat: "List my Canvas library courses" or "Summarise week 3 of <course> and quiz me."

Something wrong?  npm run doctor
`);
}

const arg = process.argv[2];
if (arg === '--desktop') addToDesktop();
else if (arg === '--doctor') await doctor();
else showSteps();
