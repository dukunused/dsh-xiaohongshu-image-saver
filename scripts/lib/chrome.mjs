// Chrome/Edge 发现、启动与生命周期管理。
// 专用 user-data-dir（登录态隔离），端口用 --remote-debugging-port=0 +
// 读 DevToolsActivePort 文件，避免端口冲突。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { httpJson } from './cdp.mjs';

export function findChrome(env = process.env, platform = process.platform) {
  const explicit = env.XHS_CHROME || env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    const cands = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    for (const c of cands) if (fs.existsSync(c)) return c;
    return null;
  }
  if (platform === 'darwin') {
    const cands = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return null;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* 继续 */ }
  }
  return null;
}

function stateFile(home) {
  return path.join(home, 'chrome.json');
}

export function readChromeState(home) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
  } catch {
    return null;
  }
}

export function writeChromeState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(stateFile(home), JSON.stringify(state));
}

export function clearChromeState(home) {
  try { fs.rmSync(stateFile(home), { force: true }); } catch { /* 忽略 */ }
}

export async function isPortAlive(port) {
  try {
    await httpJson(`http://127.0.0.1:${port}/json/version`, { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

function readDevToolsPort(userDataDir, timeoutMs = 20000) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const port = Number(raw.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0) return resolve(port);
      } catch { /* 还没写出来 */ }
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * 确保调试端口可用：复用存活实例，否则启动新实例。
 * 返回 { port, userDataDir, owned, spawnedNow, chromePath }
 */
export async function ensureChrome(home, { log = () => {} } = {}) {
  const userDataDir = path.join(home, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const prev = readChromeState(home);
  if (prev?.port && (await isPortAlive(prev.port))) {
    log(`复用已运行的 Chrome（端口 ${prev.port}）`);
    return { ...prev, spawnedNow: false };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('未找到 Chrome/Edge。可设置环境变量 XHS_CHROME 指向浏览器可执行文件。');
  }

  fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(chromePath, [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--window-size=1280,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const port = await readDevToolsPort(userDataDir);
  if (!port || !(await isPortAlive(port))) {
    throw new Error(`Chrome 启动后调试端口不可用（${chromePath}）`);
  }
  const state = { port, pid: child.pid, userDataDir, owned: true, chromePath };
  writeChromeState(home, state);
  log(`已启动 Chrome（端口 ${port}，独立登录档案）`);
  return { ...state, spawnedNow: true };
}

/** 关掉插件自己启动的浏览器（连同整个进程树）。 */
export function killChrome(state, home) {
  if (!state?.owned || !state.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(state.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(state.pid, 'SIGTERM');
    }
  } catch { /* 已经退出 */ }
  if (home) clearChromeState(home);
}
