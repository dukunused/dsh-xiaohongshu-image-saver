#!/usr/bin/env node
// 小红书用户主页图片批量保存 —— 主流程
// 用法：
//   node save.mjs --url <用户主页链接> --out <保存目录>
//                [--quality original|web] [--limit N] [--login-wait 秒]
//
// 约定：进度写 stderr，最终结果以一行 JSON 写 stdout（工具侧只解析这一行）。
// 退出码：0 = 正常（含 login_required / partial），1 = 意外失败（JSON 不输出）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectPage, sleep } from './lib/cdp.mjs';
import { extractImageList, extractTitle, extractDate, fileIdOf } from './lib/ssr.mjs';
import { ensureChrome, killChrome } from './lib/chrome.mjs';

const log = (...a) => console.error('[xhs]', ...a);

function parseArgs(argv) {
  const opts = { quality: 'original', limit: 0, loginWait: 0, url: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--url') opts.url = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--quality') opts.quality = next();
    else if (a === '--limit') opts.limit = Number(next()) || 0;
    else if (a === '--login-wait') opts.loginWait = Number(next()) || 0;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!/^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\/[0-9a-f]+/i.test(opts.url)) {
    throw new Error('url 必须是小红书用户主页链接（形如 https://www.xiaohongshu.com/user/profile/xxxx）');
  }
  if (!opts.out) throw new Error('缺少 --out（图片保存目录）');
  if (!['original', 'web'].includes(opts.quality)) throw new Error('quality 只能是 original 或 web');
  return opts;
}

const HOME = process.env.XHS_SAVER_HOME
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'xhs-saver');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function sanitize(s, max = 18) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '') || '未命名';
}

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
  return null;
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }));
}

// ---------- 登录检测 ----------

async function loginState(page) {
  return page.eval(`(() => ({
    modal: !!document.querySelector('.login-container, .login-modal'),
    wall: /登录即可查看/.test(document.body.innerText || ''),
    loginUrl: location.pathname.indexOf('/login') === 0
  }))()`);
}

async function isLoggedIn(page) {
  const s = await loginState(page);
  return !s.modal && !s.wall && !s.loginUrl;
}

// ---------- 阶段 1：翻页采集笔记清单 ----------

// 小红书的 xsec_token 是 per-note 的：主页分页接口返回的是主页 token，
// 不能用于 /explore/<id> 详情页。真正的 token 在 __INITIAL_STATE__.user.notes._value 里。
async function mergeDomTokens(page, notes) {
  const r = await page.eval(`(() => {
    try {
      const st = window.__INITIAL_STATE__;
      const notes = st && st.user && st.user.notes;
      const arr = notes && (notes._value || notes.value || notes);
      const out = {};
      if (Array.isArray(arr)) {
        for (const chunk of arr) {
          if (!Array.isArray(chunk)) continue;
          for (const n of chunk) {
            if (!n || !n.id) continue;
            out[n.id] = {
              token: n.xsecToken || '',
              title: (n.noteCard && (n.noteCard.display_title || n.noteCard.title)) || '',
              type: (n.noteCard && n.noteCard.type) || '',
            };
          }
        }
      }
      return JSON.stringify(out);
    } catch (e) { return null; }
  })()`, 120000);
  if (!r) return 0;
  let merged = 0;
  try {
    const map = JSON.parse(r);
    for (const [id, info] of Object.entries(map)) {
      const cur = notes.get(id);
      if (!cur) {
        // 分页响应 body 可能被 CDP 丢弃（No resource ...），DOM store 是更可靠的清单来源
        notes.set(id, {
          noteId: id,
          title: info.title || '',
          type: info.type || '',
          xsecToken: info.token || '',
          __homeToken: '',
        });
        merged++;
        continue;
      }
      if (info.token && (!cur.xsecToken || cur.xsecToken === cur.__homeToken)) {
        cur.xsecToken = info.token;
        merged++;
      }
      if (!cur.title && info.title) cur.title = info.title;
    }
  } catch {}
  return merged;
}

async function collectNotes(page, cacheDir) {
  // CDP 会为每个请求只保留一份 body 缓冲，稍后再取会报 "No resource with given identifier found"。
  // 所以响应一到就立刻取 body，不进队列。
  const notes = new Map();
  let noMore = false;
  const inflight = new Set();
  page.on('Network.responseReceived', (p) => {
    if (!p.response?.url?.includes('/api/sns/web/v1/user_posted')
      || p.response.status !== 200 || inflight.has(p.requestId)) return;
    inflight.add(p.requestId);
    (async () => {
      try {
        const body = await page.send('Network.getResponseBody', { requestId: p.requestId });
        const txt = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const j = JSON.parse(txt);
        if (j.success === false) { log('分页接口返回失败:', j.msg); return; }
        const token = new URL(p.response.url).searchParams.get('xsec_token') || '';
        for (const n of j.data?.notes || []) {
          if (!notes.has(n.note_id)) {
            notes.set(n.note_id, {
              noteId: n.note_id,
              title: n.display_title || '',
              type: n.type || '',
              xsecToken: token,
              __homeToken: token,
            });
          }
        }
        if (j.data && j.data.has_more === false) noMore = true;
      } catch (e) {
        log('读取分页响应失败:', e.message);
      }
    })();
  });

  await sleep(2500);
  await mergeDomTokens(page, notes);

  let stale = 0;
  let wheelSeq = 0;
  for (let round = 0; round < 150 && !noMore; round++) {
    const before = notes.size;
    await page.eval(`(() => {
      const sc = document.querySelector('.ai-mode.user-page');
      if (sc) sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      return true;
    })()`);
    await sleep(1800);
    let merged = await mergeDomTokens(page, notes);
    if (notes.size === before) {
      // scrollTo 无效时用输入级滚轮兜底（每轮轮换锚点避免命中同一个惰性区域）
      wheelSeq++;
      const m = wheelSeq % 2 ? { x: 700, y: 500 } : { x: 700, y: 800 };
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: 2400,
      }).catch(() => {});
      await sleep(1500);
      merged += await mergeDomTokens(page, notes);
    }
    if (notes.size === before && !merged) {
      stale++;
      if (stale >= 5) break;
    } else {
      stale = 0;
      if (notes.size % 60 < 30) log(`已采集 ${notes.size} 篇笔记…`);
    }
  }

  const list = [...notes.values()];
  const cacheFile = path.join(cacheDir, 'notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ updatedAt: Date.now(), items: list }, null, 2));
  log(`笔记清单完成：${list.length} 篇${noMore ? '（翻到底）' : '（到达轮次上限）'}`);
  return list;
}

// ---------- 阶段 2：逐篇抓详情（日期 + 图片地址） ----------

async function httpGet(url, cookie, referer) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 40000);
  try {
    return await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        Cookie: cookie,
        Referer: referer || 'https://www.xiaohongshu.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
  } finally {
    clearTimeout(t);
  }
}

class LoginExpired extends Error {
  constructor() { super('登录态失效'); this.name = 'LoginExpired'; }
}

async function fetchDetail(note, cookie, cache) {
  const url = `https://www.xiaohongshu.com/explore/${note.noteId}`
    + `?xsec_token=${encodeURIComponent(note.xsecToken || '')}&xsec_source=pc_user`;
  let lastErr = '';
  for (let a = 0; a < 3; a++) {
    try {
      const res = await httpGet(url, cookie);
      if (/\/login/.test(res.url || '')) throw new LoginExpired();
      const html = await res.text();
      if (/登录即可查看/.test(html) && !html.includes('"imageList"')) throw new LoginExpired();
      const r = extractImageList(html);
      if (r.images.length) {
        cache[note.noteId] = {
          date: extractDate(html) || '未知日期',
          title: extractTitle(html) || note.title || '',
          type: note.type,
          images: r.images.map((x) => {
            const d = x.urlDefault || x.url || '';
            const p = x.urlPre || '';
            return { d, p, fid: fileIdOf(d) || fileIdOf(p) || '', info: (x.infoList || []).map((y) => y.url).filter(Boolean) };
          }),
        };
        return;
      }
      lastErr = r.reason;
    } catch (e) {
      if (e.name === 'LoginExpired') throw e;
      lastErr = e.message;
    }
    await sleep(1000 * (a + 1));
  }
  throw new Error(`抓取详情失败: ${lastErr}`);
}

// ---------- 阶段 3：下载 ----------

function buildTasks(details, notes, quality) {
  const tasks = [];
  const used = new Set();
  let seq = 0;
  for (const n of notes) {
    const d = details[n.noteId];
    if (!d || !d.images || !d.images.length) continue;
    seq++;
    d.images.forEach((img, k) => {
      const base = `${d.date}_${sanitize(d.title)}_${String(k + 1).padStart(2, '0')}`;
      let name = base;
      let i = 1;
      while (used.has(name)) { i++; name = `${base}-${i}`; }
      used.add(name);
      const cands = [];
      if (quality !== 'web' && img.fid) cands.push(`https://sns-img-qc.xhscdn.com/${img.fid}`);
      cands.push(img.d, img.p, ...(img.info || []));
      tasks.push({
        name,
        noteId: n.noteId,
        date: d.date,
        title: d.title,
        idx: k + 1,
        cands: [...new Set(cands.filter(Boolean))].slice(0, 3),
      });
    });
  }
  return tasks;
}

async function downloadAll(tasks, outDir, cookie) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = path.join(outDir, '_清单.csv');
  const newManifest = !fs.existsSync(manifest);
  if (newManifest) fs.writeFileSync(manifest, '\uFEFF文件名,日期,标题,笔记ID,第几张,大小KB,画质\n');

  const stat = { saved: 0, skipped: 0, failed: 0, bytes: 0, rows: [] };

  await pool(tasks, 5, async (t) => {
    const exists = (ext) => fs.existsSync(path.join(outDir, t.name + ext));
    if (exists('.jpg') || exists('.png') || exists('.webp') || exists('.gif')) {
      stat.skipped++;
      return;
    }
    let got = null;
    for (const u of t.cands) {
      try {
        const res = await httpGet(u, cookie, 'https://www.xiaohongshu.com/');
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 3000) continue;
        const ext = sniff(buf);
        if (!ext) continue;
        if (!got || buf.length > got.buf.length) got = { buf, ext, quality: u.startsWith('https://sns-img-qc.') ? '原图' : '网页版' };
        if (u.startsWith('https://sns-img-qc.')) break; // 原图通道成功即可停
      } catch { /* 换下一个候选 */ }
    }
    if (!got) {
      stat.failed++;
      log(`下载失败: ${t.name}`);
      return;
    }
    let file = t.name + got.ext;
    let i = 1;
    while (fs.existsSync(path.join(outDir, file))) { i++; file = `${t.name}-${i}${got.ext}`; }
    fs.writeFileSync(path.join(outDir, file), got.buf);
    stat.saved++;
    stat.bytes += got.buf.length;
    stat.rows.push([file, t.date, String(t.title).replace(/[",\n]/g, ' '), t.noteId, t.idx, Math.round(got.buf.length / 1024), got.quality].join(','));
    if (stat.saved % 50 === 0) log(`已下载 ${stat.saved} 张…`);
  });

  if (stat.rows.length) fs.appendFileSync(manifest, stat.rows.join('\n') + '\n');
  return { ...stat, manifest };
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const userId = (opts.url.match(/\/user\/profile\/([0-9a-f]+)/i) || [])[1];
  const cacheDir = path.join(HOME, 'cache', userId);
  fs.mkdirSync(cacheDir, { recursive: true });

  const chrome = await ensureChrome(HOME, { log });
  const page = await connectPage(chrome.port, 'xiaohongshu');
  await page.send('Page.bringToFront');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

  await page.goto(opts.url, { settle: 3500 });

  let keepChrome = false;
  const finish = (result) => {
    if (!keepChrome) killChrome(chrome, HOME);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.status === 'ok' || result.status === 'partial' || result.status === 'login_required' ? 0 : 1);
  };

  // --- 登录 ---
  if (!(await isLoggedIn(page))) {
    if (opts.loginWait > 0) {
      log(`等待扫码登录（最多 ${opts.loginWait} 秒）…`);
      const deadline = Date.now() + opts.loginWait * 1000;
      while (Date.now() < deadline && !(await isLoggedIn(page))) await sleep(2000);
    }
    if (!(await isLoggedIn(page))) {
      keepChrome = true;
      return finish({
        status: 'login_required',
        message: '小红书未登录。已弹出专用 Chrome 窗口，请用手机小红书/微信扫码登录（可勾选记住我），登录完成后重新调用本工具。',
        outputDir: opts.out,
      });
    }
  }
  log('登录态有效，开始采集…');

  // --- 采集笔记清单 ---
  const notes = await collectNotes(page, cacheDir);
  if (!notes.length) throw new Error('没拿到任何笔记：主页可能不存在、被封禁或布局异常，请重试');

  const cookies = await page.cookies(['https://www.xiaohongshu.com/']);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!cookie) {
    keepChrome = true;
    return finish({ status: 'login_required', message: '拿不到登录 Cookie，请在弹出的窗口重新登录后重试。', outputDir: opts.out });
  }

  const todo = opts.limit > 0 ? notes.slice(0, opts.limit) : notes;
  log(`共 ${notes.length} 篇，本次处理 ${todo.length} 篇…`);

  // --- 详情 ---
  const detailsFile = path.join(cacheDir, 'details.json');
  let details = {};
  try { details = JSON.parse(fs.readFileSync(detailsFile, 'utf8')); } catch { /* 首次 */ }

  const pending = todo.filter((n) => !(details[n.noteId] && details[n.noteId].images));
  log(`详情：${todo.length - pending.length} 篇有缓存，${pending.length} 篇待抓…`);
  let fetched = 0;
  const failedNotes = [];
  try {
    await pool(pending, 4, async (n) => {
      try {
        await fetchDetail(n, cookie, details);
        fetched++;
        if (fetched % 20 === 0) fs.writeFileSync(detailsFile, JSON.stringify(details));
      } catch (e) {
        if (e.name === 'LoginExpired') throw e;
        failedNotes.push({ noteId: n.noteId, title: n.title, err: e.message });
        log(`详情失败 ${n.noteId}: ${e.message}`);
      }
      await sleep(150 + Math.random() * 250);
    });
  } catch (e) {
    if (e.name === 'LoginExpired') {
      keepChrome = true;
      return finish({
        status: 'login_required',
        message: '登录态已失效。请在弹出的 Chrome 窗口重新扫码登录后重试（已保存的进度不会丢）。',
        outputDir: opts.out,
      });
    }
    throw e;
  } finally {
    fs.writeFileSync(detailsFile, JSON.stringify(details));
  }

  // --- 下载 ---
  const tasks = buildTasks(details, todo, opts.quality);
  log(`开始下载 ${tasks.length} 张图片 → ${opts.out}`);
  const dl = await downloadAll(tasks, opts.out, cookie);

  const bytesMB = Math.round((dl.bytes / 1048576) * 10) / 10;
  return finish({
    status: failedNotes.length || dl.failed ? 'partial' : 'ok',
    notes: { total: notes.length, processed: todo.length, failed: failedNotes.length },
    images: { found: tasks.length, saved: dl.saved, skipped: dl.skipped, failed: dl.failed },
    totalBytesMB: bytesMB,
    outputDir: opts.out,
    manifest: dl.manifest,
    failedNotes: failedNotes.slice(0, 10),
  });
}

// 被外部中断时，把插件自己启动的浏览器收掉，别留孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(HOME, 'chrome.json'), 'utf8'));
      if (st?.owned) killChrome(st, HOME);
    } catch { /* 没有状态文件 */ }
    process.exit(130);
  });
}

main().catch((e) => {
  // 意外失败：不写 stdout，让工具侧以错误形式上报；插件启动的浏览器一并收掉
  log('失败:', e?.stack || e);
  try {
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'chrome.json'), 'utf8'));
    if (st?.owned) killChrome(st, HOME);
  } catch { /* 没有状态文件 */ }
  process.exit(1);
});
