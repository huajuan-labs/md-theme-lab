# 🎨 MD Theme Lab

> Markdown 主题实验室 —— 写 markdown，选主题，预览美化效果，导出图片。

20+ 主题预设（杂志 / 海报 / PPT / 公众号 / 极简 / 报纸 / 学术 / 清单 / 时间线 / 对比 / 简报...），Design Token 系统，AI 主题/调色板生成，一键导出图片。

**👉 [在线体验](https://md.huajuan-labs.com)**（静态 demo，核心功能可用）

## 两种用法

### 1. 在线 demo（静态，零安装）

打开 [md.huajuan-labs.com](https://md.huajuan-labs.com)，直接用：编辑 markdown → 选主题 → 预览 → html2canvas 导出图片。

静态模式下 AI 生成 / 主题保存不可用（需后端），底部会提示。

### 2. 自托管全栈（完整功能）

```bash
git clone https://github.com/huajuan-labs/md-theme-lab.git
cd md-theme-lab
npm install
cp .env.example .env  # 填入 ANTHROPIC_API_KEY
npm start             # http://localhost:3000
```

全栈模式解锁：AI 主题生成、AI 调色板生成、主题保存/克隆/历史、服务端 CSS 导出。

## 主题预设

| 风格 | 主题 |
|---|---|
| 杂志 | 杂志、海报、报纸 |
| 实用 | PPT、公众号、极简、简报 |
| 学术 | 学术、清单 |
| 创意 | 时间线、对比、小红书 |
| 领域 | 金融小知识、学习笔记、HR 面试、升学决策、节日科普、设计师禅意、应援签名... |

每个主题支持暖橙/玫粉/深色/企业蓝/海军/炭灰/青绿等配色变体。

## 技术栈

- **前端**：单 HTML 文件（marked + morphdom + html2canvas），Design Token 系统（CSS 变量运行时切换）
- **后端**：Express + Anthropic SDK + SQLite（主题持久化）
- **AI**：Anthropic Claude（主题生成、调色板生成、内容分析）

## 项目结构

```
md-theme-lab/
├── public/
│   ├── index.html      ← 前端单文件应用
│   └── vendor/         ← marked / morphdom / html2canvas 等
├── server.js           ← Express 后端（AI + 持久化 + 导出）
├── export-themes.js    ← 主题 CSS 打包导出
├── promax-api.js       ← 设计参考数据 API
├── data/promax/        ← 颜色/样式/字体 CSV 参考数据
└── scripts/build-vendor.mjs
```

## 部署

**Cloudflare Pages（静态前端）**：部署 `public/` 目录。核心功能（编辑 + 主题 + 预览 + 图片导出）全客户端可用。

**全栈（Node 主机）**：Railway / Render / Fly / VPS，`npm start`。需 `ANTHROPIC_API_KEY` 环境变量。

## License

MIT © [huajuan-labs](https://github.com/huajuan-labs)
