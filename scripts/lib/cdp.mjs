// 极简 CDP 客户端：连接本机 Chrome 的 DevTools 端口，跑页面脚本。
// 无第三方依赖（WebSocket 用 Node >= 22 的全局实现）。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CdpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdpError';
  }
}

export async function httpJson(url, { method = 'GET', timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { method, signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function listTargets(port) {
  return httpJson(`http://127.0.0.1:${port}/json/list`);
}

export async function openTarget(port, url) {
  const target = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  try {
    return await httpJson(target, { method: 'PUT' });
  } catch {
    return await httpJson(target, { method: 'GET' });
  }
}

async function waitOpen(ws, ms = 10000) {
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new CdpError('WebSocket 连接超时')), ms);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new CdpError('WebSocket 连接失败')); };
  });
}

class Page {
  constructor(ws, info) {
    this.ws = ws;
    this.info = info;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new CdpError(`CDP ${JSON.stringify(m.error)}`));
        else res(m.result);
      } else if (m.method) {
        for (const fn of this.handlers.get(m.method) || []) {
          try { fn(m.params); } catch { /* 单个处理器失败不影响其它 */ }
        }
      }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new CdpError(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new CdpError(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本执行失败');
    }
    return r.result.value;
  }
  async cookies(urls) {
    const r = await this.send('Network.getCookies', { urls });
    return r.cookies || [];
  }
  async goto(url, { timeout = 45000, settle = 1500 } = {}) {
    await this.send('Page.navigate', { url });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(400);
      try {
        if ((await this.eval('document.readyState')) === 'complete') {
          await sleep(settle);
          return;
        }
      } catch { /* 导航进行中 */ }
    }
    throw new CdpError(`页面加载超时: ${url}`);
  }
}

/** 连上调试端口；优先复用已打开小红书的标签页，否则新开一个。 */
export async function connectPage(port, match = 'xiaohongshu') {
  let targets = [];
  try {
    targets = await listTargets(port);
  } catch {
    throw new CdpError(`Chrome 调试端口 ${port} 不可达`);
  }
  let t = targets.find((x) => x.type === 'page' && x.url.includes(match));
  if (!t) t = await openTarget(port, 'about:blank');
  if (!t || !t.webSocketDebuggerUrl) throw new CdpError('拿不到页面调试目标');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await waitOpen(ws);
  const page = new Page(ws, t);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  return page;
}
