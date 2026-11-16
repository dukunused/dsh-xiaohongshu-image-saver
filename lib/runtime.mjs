// 解析一个能真正跑 JS 的 node：桌面端 process.execPath 是 Electron 主程序，
// 直接拿它 execFile 会启动 GUI 而不是执行脚本。候选顺序：
//   DSH_NODE / DSH_DESKTOP_NODE_EXECUTABLE → DSH 自带运行时 → PATH → Electron 以 node 模式兜底。
// 每个候选都用「写一个证明文件」实测，能写出来才算数。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function probeRuntime(file, env) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-node-'));
    const proof = path.join(dir, 'proof');
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'));
  } catch {
    return false;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function resolveNodeRuntime(dshHome = path.join(os.homedir(), '.dsh'), options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (env.USERPROFILE || env.HOME || os.homedir());
  const electron = options.electron ?? Boolean(process.versions.electron);
  const current = options.execPath ?? process.execPath;
  const probe = options.probe ?? probeRuntime;
  const bin = platform === 'win32' ? 'node.exe' : 'node';

  const cands = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE];
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try {
      for (const d of fs.readdirSync(root)) cands.push(path.join(root, d, 'dependencies', 'node', 'bin', bin));
    } catch { /* 没装过运行时 */ }
  }
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH ?? '').split(sep)) if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin));
  if (platform === 'darwin') {
    cands.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  }
  if (platform === 'win32' && env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin));

  for (const file of new Set(cands.filter(Boolean))) {
    try {
      if (fs.statSync(file).isFile() && probe(file, env)) return { file, env: { ...env } };
    } catch { /* 下一个 */ }
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    if (probe(current, nodeEnv)) return { file: current, env: nodeEnv };
  }
  throw new Error('找不到可执行脚本的 node 运行时，请设置环境变量 DSH_NODE 为真实 node 的绝对路径');
}
