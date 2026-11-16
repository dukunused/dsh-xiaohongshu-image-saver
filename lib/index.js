// dsh-xhs-saver —— 注册 xhs_save_images 工具
// 本体逻辑在 scripts/save.mjs（独立 node 脚本），这里只负责：
//   1. 用能真正跑 JS 的 node 拉起脚本
//   2. 传递参数、转发中断信号
//   3. 把脚本的 JSON 结果变成工具的规范返回值

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveNodeRuntime } from './runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'save.mjs');
const HARD_TIMEOUT_MS = 20 * 60 * 1000;

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* 已退出 */ }
}

function tail(s, n = 1500) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(-n) : s;
}

export const name = 'dsh-xhs-saver';
export const inject = ['tools'];

export function apply(ctx) {
  const dispose = ctx.tools.register(defineTool({
    name: 'xhs_save_images',
    description:
      '批量保存小红书某用户主页的全部笔记图片到本地目录：自动翻完所有笔记、按发布日期命名、平铺在同一个文件夹，默认下载原图，支持断点续传。'
      + '首次使用或登录过期时返回 status=login_required，此时会弹出一个专用 Chrome 窗口，让用户扫码登录后重新调用。',
    parameters: {
      userUrl: {
        type: 'string',
        required: true,
        description: '小红书用户主页链接，形如 https://www.xiaohongshu.com/user/profile/xxxx（分享链接里的 xsec_token 可以带上）',
      },
      outputDir: {
        type: 'string',
        required: true,
        description: '图片保存到的本地绝对路径；目录不存在会自动创建',
      },
      quality: {
        type: 'string',
        enum: ['original', 'web'],
        description: 'original=原图（默认，清晰但体积大）；web=网页压缩版（体积约为原图三分之一）',
      },
      limit: {
        type: 'integer',
        description: '只处理前 N 篇笔记（调试用）；省略表示全部笔记',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['ok', 'partial', 'login_required'],
            description: 'ok=全部完成；partial=有少量笔记或图片失败；login_required=需要用户扫码登录',
          },
          message: { type: 'string', description: 'status 为 login_required 时给用户的操作说明' },
          notes: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', description: '主页笔记总数' },
              processed: { type: 'integer', description: '本次处理的笔记数' },
              failed: { type: 'integer', description: '详情抓取失败的笔记数' },
            },
          },
          images: {
            type: 'object',
            additionalProperties: false,
            properties: {
              found: { type: 'integer', description: '发现的图片总数' },
              saved: { type: 'integer', description: '本次新保存的图片数' },
              skipped: { type: 'integer', description: '已存在而跳过的图片数' },
              failed: { type: 'integer', description: '下载失败的图片数' },
            },
          },
          totalBytesMB: { type: 'number', description: '本次写入的字节数（MB）' },
          outputDir: { type: 'string', description: '保存目录' },
          manifest: { type: 'string', description: '清单 CSV 的路径' },
          failedNotes: { type: 'array', items: { type: 'json' }, description: '失败笔记明细（最多 10 条）' },
        },
      },
      render: (_args, v) => {
        if (v.status === 'login_required') {
          return [{ type: 'text', text: v.message || '需要先在弹出的 Chrome 窗口扫码登录。' }];
        }
        const n = v.notes || {};
        const im = v.images || {};
        const lines = [
          `${v.status === 'partial' ? '部分完成' : '完成'}：保存 ${im.saved} 张图片（已存在跳过 ${im.skipped}，失败 ${im.failed}）`
          + `，来自 ${n.processed}/${n.total} 篇笔记，写入 ${v.totalBytesMB} MB。`,
          `目录：${v.outputDir}`,
          `清单：${v.manifest}`,
        ];
        if (v.failedNotes?.length) {
          lines.push('失败笔记：' + v.failedNotes.map((f) => `${f.title || f.noteId}(${f.err})`).join('；'));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const runtime = resolveNodeRuntime(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
      const argv = [SCRIPT, '--url', args.userUrl, '--out', args.outputDir];
      if (args.quality) argv.push('--quality', args.quality);
      if (args.limit) argv.push('--limit', String(args.limit));

      const child = spawn(runtime.file, argv, {
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      });

      let out = '';
      let err = '';
      let timedOut = false;
      const onAbort = () => killTree(child);
      exec.signal.addEventListener('abort', onAbort, { once: true });
      const hardTimer = setTimeout(() => { timedOut = true; killTree(child); }, HARD_TIMEOUT_MS);

      child.stdout.on('data', (c) => { if (out.length < 200000) out += c; });
      child.stderr.on('data', (c) => { if (err.length < 100000) err += c; });

      const code = await new Promise((resolve) => {
        child.on('close', (c) => resolve(c));
        child.on('error', (e) => { err += '\n' + e.message; resolve(-1); });
      });
      clearTimeout(hardTimer);
      exec.signal.removeEventListener('abort', onAbort);

      if (timedOut) throw new Error('保存超时（20 分钟上限），已终止。可加 limit 参数先试小批量。');
      if (exec.signal.aborted) throw new Error('已取消');

      const lines = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      if (code === 0 && lines.length) {
        try { return JSON.parse(lines[lines.length - 1]); } catch { /* 落到下面报错 */ }
      }
      throw new Error(`小红书图片保存失败（退出码 ${code}）：${tail(err || out)}`);
    },
  }));

  return () => { try { dispose?.(); } catch { /* 已卸载 */ } };
}
