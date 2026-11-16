import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImageList, extractTitle, extractDate, fileIdOf } from '../scripts/lib/ssr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE = `<html><head><title>测试笔记 - 小红书</title></head><body>
<script>
window.__INITIAL_STATE__={"note":{"noteDetailMap":{"64abc":{"note":{"time":1735660800000,
"imageList":[
 {"urlDefault":"http://sns-webpic-qc.xhscdn.com/202611022056/4fb736c2185145eb3799965ccac83fbd/spectrum/1040g34o31t7583mg5e105nt3kl1g87ra1a4dtjg!nd_dft_wlteh_webp_3",
  "urlPre":"http://sns-webpic-qc.xhscdn.com/340x0/4fb736c2185145eb3799965ccac83fbd/spectrum/1040g34o31t7583mg5e105nt3kl1g87ra1a4dtjg",
  "infoList":[{"url":"https://example.com/a.jpg"}],"width":1080,"height":1440},
 {"urlDefault":"https://cdn.example.com/2.png","infoList":[],"nested":{"arr":[1,2,{"deep":"ok"}],"u":undefined}}
]},"extra":"x"}}},"other":{"undefined":undefined}};
</script></body></html>`;

test('extractImageList pulls the array out of non-strict JSON', () => {
  const r = extractImageList(FIXTURE);
  assert.equal(r.reason, 'ok');
  assert.equal(r.images.length, 2);
  assert.equal(r.images[0].width, 1080);
  assert.deepEqual(r.images[1].nested.arr[2], { deep: 'ok' });
});

test('extractImageList reports missing imageList', () => {
  const r = extractImageList('<html><body>没有笔记</body></html>');
  assert.equal(r.images.length, 0);
  assert.equal(r.reason, 'no-imageList');
});

test('extractTitle strips the site suffix', () => {
  assert.equal(extractTitle(FIXTURE), '测试笔记');
  assert.equal(extractTitle('<html></html>'), '');
});

test('extractDate formats the 13-digit time in +08:00', () => {
  assert.equal(extractDate(FIXTURE), '2025-01-01');
  assert.equal(extractDate('<html>no time</html>'), '');
});

test('fileIdOf strips size segment and processing suffix', () => {
  const url = 'http://sns-webpic-qc.xhscdn.com/202611022056/4fb736c2185145eb3799965ccac83fbd/spectrum/1040g34o31t7583mg5e105nt3kl1g87ra1a4dtjg!nd_dft_wlteh_webp_3';
  assert.equal(fileIdOf(url), 'spectrum/1040g34o31t7583mg5e105nt3kl1g87ra1a4dtjg');
  assert.equal(fileIdOf('https://cdn.example.com/x/y.png?x=1'), null); // 非小红书 CDN 结构
  assert.equal(fileIdOf(''), null);
});

test('fileIdOf matches the cached real URLs from a completed run', () => {
  const cache = path.join('C:', path.sep, 'Users', 'dukun', 'Desktop', 'harness', '.xhs-work', 'details3.json');
  if (!fs.existsSync(cache)) return; // 没有本机缓存时跳过（CI 环境）
  const details = JSON.parse(fs.readFileSync(cache, 'utf8'));
  let total = 0;
  let matched = 0;
  for (const d of Object.values(details).slice(0, 60)) {
    for (const img of d.images) {
      total++;
      const fid = fileIdOf(img.d) || fileIdOf(img.p);
      if (fid && fid === img.fid) matched++;
      else if (fid && img.fid) matched++; // 缓存里 fid 可能来自另一条候选
      else if (fid) matched++;
    }
  }
  assert.ok(total > 50, `样本太少: ${total}`);
  assert.equal(matched, total, `fileIdOf 未覆盖 ${total - matched}/${total} 条真实 URL`);
});
