// 从小红书笔记页的 SSR HTML 里提取图片列表与标题。
// __INITIAL_STATE__ 不是合法 JSON（含 undefined），用括号配对截出 imageList 再解析。

export function extractImageList(html) {
  const start = html.indexOf('"noteDetailMap"');
  const from = start >= 0 ? start : 0;
  const idx = html.indexOf('"imageList":[', from);
  if (idx < 0) return { images: [], reason: 'no-imageList' };
  const arrStart = html.indexOf('[', idx);
  let i = arrStart;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  let json = html.slice(arrStart, i);
  json = json.replace(/([:\[,])\s*undefined\s*([,}\]])/g, '$1null$2');
  try {
    const arr = JSON.parse(json);
    return { images: arr, reason: 'ok' };
  } catch (e) {
    return { images: [], reason: 'parse:' + e.message };
  }
}

export function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1].replace(/\s*-\s*小红书\s*$/, '').trim() : '';
}

/** 笔记发布时间（Asia/Shanghai）：从 noteDetailMap 段里找第一个 13 位 time。 */
export function extractDate(html) {
  const seg = html.indexOf('"noteDetailMap"');
  const from = seg >= 0 ? seg : 0;
  const m = html.slice(from).match(/"time"\s*:\s*(\d{13})/);
  if (!m) return '';
  const d = new Date(Number(m[1]) + 8 * 3600 * 1000); // 固定 +8，取 UTC 日期字段
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 从图片 CDN 地址里剥出原图资源路径（去掉尺寸段与处理后缀）。 */
export function fileIdOf(url) {
  const noQ = String(url || '').split('!')[0].split('?')[0];
  const m = noQ.match(/^https?:\/\/[^/]+\/(?:\d{12,}\/)?[0-9a-f]{16,}\/(.+)$/);
  return m ? m[1] : null;
}
