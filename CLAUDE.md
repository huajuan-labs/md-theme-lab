# CLAUDE.md — MD Theme Lab

## 项目概述

Markdown 主题实验室 —— ZoneDSL 的主题扩展工具，也可独立使用。写 markdown → 选主题 → 预览 → 导出图片/CSS。设计的主题可导出为 ZoneDSL `.wxss` 主题文件。

## 架构

**全栈单仓库**，前端 + 后端同 repo：

- `public/index.html` — 前端单文件应用（12k 行），含编辑器 + 主题预览 + 导出 + AI 生成 UI
- `server.js` — Express 后端（~1430 行），AI 调用 + SQLite 持久化 + 主题导出
- `export-themes.js` — 主题 CSS 打包逻辑（buildBundle）
- `promax-api.js` — 设计参考数据 API（colors/styles/typography CSV）
- `data/promax/` — 设计参考 CSV 数据
- `Dockerfile` + `docker-compose.yml` — 容器化（端口 19527）

## 开发 / 运行

```bash
npm install
npm start          # http://localhost:3000（或 .env 里 PORT=19527）
# 或 Docker
docker compose up -d
```

## API 配置

**双格式支持**：OpenAI 兼容（`/chat/completions`）+ Anthropic（`/v1/messages`）

- **界面配置**：齿轮 ⚙ 按钮 → API Key / Base URL / Model / 格式 → localStorage
- **.env 配置**：`ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` + `CLAUDE_MODEL`
- 后端 `getAIConfig(req)` 读 `X-User-*` header → fallback 到 .env
- `callAI()` / `callAIStream()` 统一调用，按 format 分发

## 关键设计

- **Design Token 系统**：CSS 变量（`--accent`/`--bg`/`--text`/`--border`），运行时 `applyTokens()` 切换
- **headingInherit 模式**：h3 继承 h1 样式（原 hotsearch 模式改名，给简报类 ### 标题用）
- **20+ 主题预设**：杂志/海报/PPT/公众号/学术/时间线/小红书/简报等，每个有配色变体
- **全屏预览**：`fullscreen-btn` 切换 `.preview-wrap.fullscreen`，ESC 退出
- **静态降级**：无后端时 `/api/health` 探测失败 → 底部提示条，核心功能（编辑+主题+预览+图片导出）仍可用

## 约定

- 前端是单 HTML 文件，所有 CSS/JS 内联，不拆分（`public/vendor/` 只有第三方库）
- 后端是单 `server.js`，ESM（`"type": "module"`）
- SQLite 存 `data/user-themes.db`（gitignored，不入仓库）
- `.env` 不入仓库（gitignored），只有 `.env.example`
- 主题数据 = JSON（id/name/layout/color/css/token），存 SQLite + 可导出 CSS

## ZoneDSL 联动

设计的主题可导出为 ZoneDSL 兼容 `.wxss`：
- 变量映射：`--accent` → `--mz-accent`、`--bg` → `--mz-bg`、`--text` → `--mz-ink` 等
- 选择器改写：`.markdown-body h1` → `.zone-theme-{id} .h2w__h1`
- 输出 `.wxss` 文件，放入 ZoneDSL `packages/wechat/themes/`

## 清理记录

项目从内部项目抽离，已清理：
- 零微博/热搜/weibo 引用（变量名 hotsearch → briefing/headingInherit）
- 零真人名（迪丽热巴/吴倩 → 示例艺人）
- AGNES_* 独立变量合并到 ANTHROPIC_* 统一配置
- .env 真实 key 不入仓库
