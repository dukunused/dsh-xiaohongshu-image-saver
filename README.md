# 小红书图片保存（XHS image saver）

**小红书专用**：把**小红书（Xiaohongshu / RED）一个用户主页里的全部笔记图片**批量下载到本地目录。只认 `xiaohongshu.com/user/profile/...` 主页链接，不是通用下载器。

## 应用场景

- 收藏喜欢的穿搭 / 家居 / 美食博主，整页图包离线存下来；
- 表情包、头像、壁纸这类多图合集笔记，原图通道拿到的是无压缩大图；
- 备份自己发过的笔记图片；
- 按发布日期归档做素材整理（文件名自带日期，直接排序）。

不适合：视频笔记（只取封面）、二次分发用途。

## 它做什么

调用工具 `xhs_save_images`，传入用户主页链接和保存目录，插件会：

1. 启动一个专用 Chrome 窗口（首次需要扫码登录，登录态保存在 `~/.dsh/xhs-saver/profile`，之后免登）；
2. 自动滚动翻完该用户的全部笔记清单（含分页接口拦截，拿到每篇的 `xsec_token`）；
3. 逐篇抓取详情页，提取**发布日期**和图片地址；
4. 下载**原图**（`sns-img-qc.xhscdn.com` 无后缀资源，实测 2000px 级别），失败时退回网页压缩版；
5. 按 `日期_标题_序号.扩展名` 平铺保存在同一个文件夹，并生成 `_清单.csv`。

## 用法

在 DSH 会话里直接说：

> 把 https://www.xiaohongshu.com/user/profile/xxxx 的图片保存到 D:\photos\xxx

或由 agent 显式调用：

```json
{
  "userUrl": "https://www.xiaohongshu.com/user/profile/xxxx",
  "outputDir": "C:/Users/you/Pictures/xhs",
  "quality": "original"
}
```

- `quality`：`original`（默认，原图）或 `web`（网页压缩版，约三分之一大小）。
- `limit`：只处理前 N 篇，调试用。
- 返回 `status: login_required` 时：按 `message` 提示用户在弹出的窗口扫码，然后重新调用；进度（笔记清单、详情缓存、已下载文件）都会保留，重试不重头来。

## 参数（环境变量）

| 变量 | 作用 |
| --- | --- |
| `XHS_CHROME` | 指定 Chrome/Edge 可执行文件路径（自动探测失败时用） |
| `XHS_SAVER_HOME` | 状态目录，默认 `~/.dsh/xhs-saver`（登录档案与缓存） |
| `DSH_NODE` | 指定跑脚本用的 node（一般不用设） |

## 限制与注意事项

- **需要登录**：小红书未登录不暴露笔记列表，所以必须扫码一次。
- **只保存图片**：视频笔记只取封面图，不下载视频。
- **频率克制**：详情抓取与下载之间有随机延迟，单次调用请勿高频反复触发；账号被平台风控时工具会返回失败，请停一会再试。
- **版权**：下载内容仅供个人学习收藏，请勿二次分发；使用行为由使用者自行负责。
- 大账号（数百篇）通常需要几分钟，工具硬超时 20 分钟。

## 安装到 DSH

两种方式：

1. **插件页安装**：DSH 设置 → 插件 → Add plugin → 选择本目录；
2. **从 GitHub 安装**（发布后）：把仓库 clone 到本地，然后按方式 1 选择该目录。

```sh
git clone https://github.com/dukunused/dsh-xiaohongshu-image-saver.git
# 然后在 DSH 插件页 Add plugin 选择克隆出来的目录
```

## 开发

```sh
node --test tests/*.test.mjs        # 单元测试
node scripts/save.mjs --url <主页> --out <目录> --limit 2   # 手动小批量验证
```

MIT License.
