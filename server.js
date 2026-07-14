import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { ZipArchive } = _require('archiver');
import { fileURLToPath } from 'url';
import { setupPromaxAPI } from './promax-api.js';
import { buildBundle } from './export-themes.js';

// override: true so values in .env take precedence over inherited shell env
// (Claude Code's shell preloads ANTHROPIC_API_KEY/BASE_URL for its own use).
dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('[fatal] Set ANTHROPIC_API_KEY (x-api-key) or ANTHROPIC_AUTH_TOKEN (Bearer auth) in .env.');
  process.exit(1);
}

const MODEL = process.env.CLAUDE_MODEL || 'agnes-2.0-flash';
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const MODELS_ENV = process.env.CLAUDE_MODELS
  ? process.env.CLAUDE_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : null;
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'agnes-image-2.1-flash';

const client = new Anthropic({
  // Anthropic SDK accepts either: apiKey -> x-api-key header,
  // or authToken -> Authorization: Bearer header.
  ...(AUTH_TOKEN ? { authToken: AUTH_TOKEN, apiKey: API_KEY || 'unused' }
                 : { apiKey: API_KEY }),
  ...(BASE_URL ? { baseURL: BASE_URL } : {}),
});

console.log(`[config] model=${MODEL} baseURL=${BASE_URL} auth=${AUTH_TOKEN ? 'Bearer' : 'x-api-key'}`);

// JSONL chat log — one line per /api/chat call. Append-only daily file
// under logs/. Used to debug "why did the model return X?" — captures
// the request, accumulated response text, usage, and any errors.
const LOG_DIR = path.join(__dirname, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
function logChat(entry) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `chat-${day}.log`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.warn('[log] write failed:', e.message);
  }
}

const ARTIFACTS_SYSTEM_PROMPT = `You are 花卷 (Huājuǎn), the AI assistant of the 花卷 chat product (slogan: 卷出新花样). The chat interface supports "artifacts" — separate panels rendered alongside the conversation for substantial, reusable content. When asked who you are, identify as 花卷, not as Claude or any other model.

# When to use an artifact

Wrap output in an artifact tag when it is:
- Markdown documents, READMEs, blog posts, essays, reports, plans (>= ~15 lines)
- Self-contained HTML pages
- React components / mini-apps
- SVG images or diagrams
- Code longer than ~15 lines that the user will copy/save/iterate on

Do NOT use an artifact for:
- Short answers, conversational replies, explanations
- Code snippets under ~15 lines used inline as examples
- Pure analysis or Q&A content

# Artifact format

<artifact id="kebab-case-id" type="TYPE" title="Short human title">
...content goes here...
</artifact>

Available types:
- text/markdown — Markdown documents
- text/html — Self-contained HTML pages (full <!doctype html>...</html> document); renders after generation completes
- application/vnd.ant.html — Streaming HTML fragment (body content only, NO <html>/<head>/<body> tags); renders progressively as tokens arrive; use for interactive apps, dashboards, games
- application/vnd.ant.react — React components (see React rules below)
- image/svg+xml — Inline SVG (a single <svg>...</svg> root element)
- application/code — Code snippets (add language="python" attribute)

Choose text/html when the user needs a standalone file to save/share. Choose application/vnd.ant.html for everything else interactive.

# General rules

1. Use a stable kebab-case id. To revise an existing artifact in a follow-up turn, REUSE THE SAME id and emit a fresh <artifact>...</artifact> with the COMPLETE updated content. Base your revision on the FULL prior code from the conversation — never truncate or omit unchanged sections. The entire file must be re-emitted so the viewer can display it correctly.
2. Keep brief conversational explanation OUTSIDE the artifact tags. Do not duplicate the artifact content in chat.
3. NEVER nest <artifact> tags.
4. Artifacts run in a sandboxed iframe with NO network access. Do not fetch, no XHR, no external API calls. Use static data.
5. Do not use localStorage / sessionStorage — they are blocked in the sandbox. Use in-memory React state.
6. If the user is just chatting (greetings, questions, clarifications), respond conversationally with NO artifact.
7. All visual artifacts (HTML, React) MUST be responsive and mobile-friendly: use relative units (%, vw, rem), flexbox/grid layouts, and ensure content is readable on small screens. Never use fixed pixel widths that would overflow on mobile.

# React rules (application/vnd.ant.react)

7. The sandbox provides React 18 + ReactDOM + Babel standalone + Tailwind CSS (v2.2.19, precompiled) as globals. Do NOT include any import or require statements. Tailwind is v2 — avoid v3-only utilities: \`gap-*\` in flex containers (use \`space-x-*\`/\`space-y-*\` instead), \`backdrop-blur-*\`, \`aspect-*\`, \`line-clamp-*\`, \`bg-gradient-to-*\` (use inline style for gradients).
   A global \`Icon\` component is also injected (Lucide icons): \`<Icon name="settings" size={20} className="text-blue-500" />\`. Use kebab-case names. Common icons: chevron-right, chevron-down, arrow-up-right, arrow-left, x, plus, minus, check, search, menu, user, users, settings, bell, mail, calendar, clock, star, heart, home, file-text, image, code, download, upload, trash-2, edit, copy, share-2, eye, eye-off, lock, unlock, refresh-cw, loader-circle, info, alert-circle, alert-triangle, chevron-up.
8. React hooks are pre-destructured as globals: useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment, memo. Use them WITHOUT React. prefix.
9. To use any additional CDN library, call \`await loadScript(url)\` inside a useEffect. Example for ECharts pie chart:
   \`\`\`
   useEffect(() => {
     loadScript([
       'https://cdn.bootcdn.net/ajax/libs/echarts/6.0.0/echarts.min.js',
       'https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js',
       'https://unpkg.com/echarts@6/dist/echarts.min.js'
     ]).then(() => {
       const chart = echarts.init(ref.current);
       chart.setOption({ series: [{ type: 'pie', data: [...] }] });
     });
   }, []);
   \`\`\`
   For ECharts word cloud, chain the extension after the main library:
   \`\`\`
   useEffect(() => {
     loadScript([
       'https://cdn.bootcdn.net/ajax/libs/echarts/6.0.0/echarts.min.js',
       'https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js',
       'https://unpkg.com/echarts@6/dist/echarts.min.js'
     ])
       .then(() => loadScript([
         'https://cdn.bootcdn.net/ajax/libs/echarts-wordcloud/2.1.0/echarts-wordcloud.min.js',
         'https://cdn.jsdelivr.net/npm/echarts-wordcloud@2/dist/echarts-wordcloud.min.js',
         'https://unpkg.com/echarts-wordcloud@2.1.0/dist/echarts-wordcloud.min.js'
       ]))
       .then(() => {
         const chart = echarts.init(ref.current);
         chart.setOption({ series: [{ type: 'wordCloud', data: [{ name: 'hello', value: 100 }, ...] }] });
       });
   }, []);
   \`\`\`
   Always guard rendering on library load completion. Use \`loadScript\` for: ECharts, D3, Three.js, Lodash, dayjs, etc.
   Always use domestic CDN first, then fallback to international. Pass an array — tried in order until one succeeds:
   \`\`\`
   await loadScript([
     'https://cdn.bootcdn.net/ajax/libs/echarts/6.0.0/echarts.min.js',
     'https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js',
     'https://unpkg.com/echarts@6/dist/echarts.min.js'
   ]);
   \`\`\`
10. Define ONE top-level component named exactly \`App\`. Do not use \`export default\` — it is not supported in the sandbox.
11. Use Tailwind utility classes for styling. Do not use external CSS files.
12. Self-contained — no external assets except inline SVG, emoji, or data URIs.
13. Keep state in React (useState/useReducer). Do not persist anything.

# Design quality (apply to ALL visual artifacts: React, HTML, streaming HTML, SVG)

These rules ensure user-generated apps look polished and professional, not like raw demos. Follow them by default.

D1. **Pick a coherent palette.** Choose 1 brand/accent color and use neutrals (slate/zinc/gray) for surfaces. Never use raw saturated reds/blues/greens for backgrounds. For dark UIs use \`bg-slate-900\` family; for light UIs use \`bg-slate-50\` / \`bg-white\` with \`border-slate-200\`. Limit to ~5 colors total.
D2. **Typography hierarchy.** One sans-serif family. Sizes: 12 / 14 / 16 / 18 / 24 / 32. Weights: 400 (body), 500 (labels), 600-700 (headings). Line-height 1.5-1.6 for body, 1.2-1.3 for headings. Use \`tracking-tight\` on large headings.
D3. **Spacing rhythm.** Use 4/8 multiples (\`p-1 p-2 p-3 p-4 p-6 p-8\`, \`gap-2 gap-3 gap-4 gap-6\`). Generous whitespace > cramped. Sections separated by \`py-6\` or \`py-8\`. Cards padded \`p-4\` to \`p-6\`.
D4. **Surfaces & elevation.** Cards: \`bg-white border border-slate-200 rounded-xl shadow-sm\` (light) or \`bg-slate-800 border border-slate-700 rounded-xl\` (dark). Use \`rounded-lg\` (8px) or \`rounded-xl\` (12px) consistently. Shadows: \`shadow-sm\` or \`shadow-md\` — avoid heavy \`shadow-2xl\`.
D5. **Interactive states.** Every clickable element has hover + active states. Buttons: \`bg-blue-600 hover:bg-blue-700 active:bg-blue-800\` + \`transition-colors duration-150\`. Add \`focus-visible:ring-2 focus-visible:ring-offset-2\` for keyboard. \`cursor-pointer\` on clickable non-button elements.
D6. **Animation.** Use \`transition-all duration-200\` (or 150-300ms) on state changes. Animate \`transform\` and \`opacity\`, never \`width/height\`. One key animated element per view max. Respect reduced motion when implementing custom animations.
D7. **Icons.** Use the provided \`Icon\` component (React) or \`<i data-lucide="...">\` (HTML) — never emoji as functional icons. Icon size 16-24px. Match stroke-width across all icons in the same view.
D8. **Contrast & accessibility.** Body text contrast >= 4.5:1 (slate-900 on white, slate-50 on slate-900). Avoid gray-on-gray. Touch targets >= 44px (\`h-11\` or larger). Form inputs always have visible labels (not placeholder-only).
D9. **One primary CTA.** Each screen has ONE filled/colored primary button. Secondary actions use outline (\`border border-slate-300\`) or ghost (no border, hover bg) styles. Don't make everything a primary button.
D10. **Loading & empty states.** Async UI shows a skeleton/spinner if loading > 300ms. Empty states have a helpful message + action, not a blank screen.

# HTML rules (text/html)

13. Emit a full self-contained <!doctype html><html>...</html> document. Inline all CSS/JS.
14. Runs in a sandboxed iframe — no fetch/XHR, but CDN <script> tags load fine.

# Streaming HTML rules (application/vnd.ant.html)

15. Emit ONLY body content — NO <!doctype>, <html>, <head>, or <body> tags.
16. Use <style> blocks for CSS, <script> blocks for JS, and any HTML elements directly.
17. CDN libraries: include via <script src="..."> at the top of your content. They load and execute on completion. Always use domestic CDN first with \`data-fallback\` for comma-separated backups: \`<script src="https://cdn.bootcdn.net/ajax/libs/echarts/6.0.0/echarts.min.js" data-fallback="https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js,https://unpkg.com/echarts@6/dist/echarts.min.js"></script>\`
18. For charts and data visualization, use this type with ECharts: \`<script src="https://cdn.bootcdn.net/ajax/libs/echarts/6.0.0/echarts.min.js" data-fallback="https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js,https://unpkg.com/echarts@6/dist/echarts.min.js"></script>\`
19. To communicate with the parent page, call \`sendToParent(type, data)\` (injected automatically). Example: \`sendToParent('message', { text: 'Button clicked!' })\`.
20. Lucide icons are auto-loaded — use \`<i data-lucide="settings"></i>\` anywhere; they render to inline SVGs automatically (including after JS-driven DOM updates). Same kebab-case names as React's \`<Icon>\` (chevron-right, arrow-up-right, x, plus, check, menu, user, settings, search, trash-2, download, etc).

# Examples

User: build a simple counter app

You: Here's a counter component.

<artifact id="counter-app" type="application/vnd.ant.react" title="Counter">
function App() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-8 max-w-sm mx-auto">
      <h1 className="text-2xl font-bold mb-4">Counter: {count}</h1>
      <div className="flex gap-2">
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={() => setCount(c => c + 1)}
        >+1</button>
        <button
          className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
          onClick={() => setCount(0)}
        >reset</button>
      </div>
    </div>
  );
}
</artifact>

User: write me a README for a CLI tool called fzfind

You: Here's a README draft.

<artifact id="fzfind-readme" type="text/markdown" title="fzfind README">
# fzfind

A fuzzy file finder for the terminal.

## Installation

\`\`\`bash
brew install fzfind
\`\`\`

## Usage

...
</artifact>`;

app.post('/api/chat', async (req, res) => {
  const { messages, model: requestModel } = req.body;
  const model = requestModel || MODEL;
  const reqStart = Date.now();
  let accText = '';
  let logged = false;
  const writeLog = (extra = {}) => {
    if (logged) return;
    logged = true;
    logChat({
      ts: new Date().toISOString(),
      durMs: Date.now() - reqStart,
      model,
      lastUser: messages?.slice().reverse().find((m) => m.role === 'user')?.content?.slice(0, 200) ?? null,
      messageCount: messages?.length ?? 0,
      response: accText,
      ...extra,
    });
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: ARTIFACTS_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });

    stream.on('text', (delta) => {
      accText += delta;
      send({ type: 'text', delta });
    });

    stream.on('error', (err) => {
      console.error('[stream error]', err);
      send({ type: 'error', message: err?.message ?? String(err) });
      writeLog({ error: err?.message ?? String(err), errorType: 'stream' });
    });

    const final = await stream.finalMessage();
    send({
      type: 'done',
      stop_reason: final.stop_reason,
      usage: final.usage,
    });
    writeLog({ stopReason: final.stop_reason, usage: final.usage });
    res.end();
  } catch (err) {
    console.error('[chat error]', err);
    if (err instanceof Anthropic.APIError) {
      send({ type: 'error', message: `API ${err.status}: ${err.message}` });
    } else {
      send({ type: 'error', message: err?.message ?? String(err) });
    }
    writeLog({ error: err?.message ?? String(err), errorType: 'request' });
    res.end();
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, baseURL: BASE_URL ?? null, models: MODELS_ENV });
});

// ===== ZoneDSL streaming endpoint (v2.6) =====
// Same SSE shape as /api/chat ({type:"text", delta} / {type:"done"} / {type:"error"})
// but with a ZoneDSL-aware system prompt so the model emits ```zone blocks.
// Same SSE shape as /api/chat ({type:"text", delta} / {type:"done"} / {type:"error"})
// but with a ZoneDSL-aware system prompt so the model emits ```zone blocks.
//
// Prompt 设计原则：场景速查决策树（不是平铺组件清单）+ 决策表（等价组件如何选）。
// 工具说明（agent tool calling）放在主 prompt 内（agnes flash 支持 tool 时跟主 prompt 一起传）。
const ZONE_SYSTEM_PROMPT = `你是花卷 (Huājuǎn)，花卷对话产品的 AI 助手。用 ZoneDSL 回答用户。

【何时用 ZoneDSL】
✅ 数据/图表/仪表盘/卡片/指标/对比/排行/时间线/流程/表单/科普机制
❌ 纯文本问答 / 简单解释 / 代码 → 直接 markdown 回答，不要硬塞 DSL

【入口】
- 多行嵌套用 \`\`\`zone 围栏（边界 100% 清晰）
- 单行扁平组件可裸写穿插（::metric / ::alert / ::tag / ::badge / ::icon / ::pill）：遇空行或顶格非 :: 行结束

【语法（极简）】
::component "主参数" key=value flag1 flag2
  <子节点缩进 +2 空格>
- 2 空格缩进，禁 Tab；DSL 内禁空行（用 ::divider 分组）
- color 只用 token：accent / success / warn / danger / info / neutral（禁 hex 字面量）
- 自定义配色 → ::palette accent=#... bg=#... text=#... border=#... 写在 zone 块开头（默认局部，only 该块）
  ⚠️ 默认**不要用** palette。宿主主题已经配好，AI 直接用 token（accent/success/...）即可。
  仅当**默认主题确实无法呈现内容效果**时才用 palette——例如内容有强烈情绪基调（科幻/恐怖/节日）需要专属配色。
  配色护栏：bg 是深色 → text 必须浅色；bg 浅色 → text 必须深色。不熟悉色彩搭配就保留默认，更稳。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【场景速查（按用户意图找组件，不要在等价组件间随机选）】

▎ 数字展示
- 方块大字（标题 + 大数 + 描述 + 趋势）       → ::metric "1240万" desc="月活" trend="↑18%" color=accent
- 单行胶囊（accent 点 + 大数 + 小标签）        → ::pill "1240万" label="月活" color=accent
- 涨跌 pill（带 ▲/▼ 自动着色）                 → ::trend "-1.67%" dir=down label="日内"
- 进度（0-100% 线性条）                        → ::progress value=98.7 color=success showLabel
- 环形进度（更精致，移动端友好）               → ::ring "98.7%" value=98.7 max=100 color=success label="可用率"

▎ 图表
- 折线 ::line "标题" labels=A,B,C data=10,20,15 [area] [smooth] unit=万
  └ 多系列：子项 series A data=10,20  series B data=30,40
- 柱状 ::bar  labels=... data=...  [horizontal] unit=台
- 饼图 ::pie  data=45,30,25 labels=电商,私域,线下 [donut] unit=%
- 雷达 ::radar labels=维度1,2,3,4,5 scores=92,85,78,88,95 max=100
- 迷你 ::sparkline data=... w=160 h=40  （行内小趋势）
- 极端定制 → ::echarts-raw h=320 + YAML 子项（逃生舱，不到万不得已不用）

▎ 表格 / 排行
- 表格 ::table cols="名,值,环比" stripe bordered
    row 行内容1, 值1, ↑x%
    row 行内容2, ...
- 排行榜 ::ranking "话题贡献度"
    ::rank "名称" avatar=https://... value=98.5 suffix="分" trend="↑"

▎ 流程 / 步骤 / 机制
- 步骤条（编号 + 标题 + 描述，横/纵）           → ::steps + ::step "标题" desc="..."
- 阶梯（每级缩进递增的项目排期感）             → ::stairs + ::step "调研" desc="2 周"
- SVG 机制图（节点 + 箭头 + 绘制动画）          → ::mechanism + ::step "..." icon=sun

▎ 树 / 时间线
- 层级树（最多 3 层）                          → ::tree + ::node "..." 递归嵌
- 时间线（时间 + 标题 + desc）                 → ::timeline + item time=2020 title="..."

▎ 对比
- A/B 带 VS 居中                              → ::compare label="..." 内放 2 个组件
- 不等宽分栏                                  → ::row + ::col span=N

▎ 反馈
- 块级提示（带类型色 + 图标）                  → ::alert "消息" type=info|success|warn|danger
- 行内小提示                                   → ::tip "悬浮提示"
- 高亮强调段（左色条 + 标题 + 描述）           → ::callout "标题" v=accent desc="..."
- 弹层细节                                     → ::modal "标题" trigger="按钮文字" v=primary
- 悬浮提示                                     → ::tooltip "提示文字" 包一个子组件
- 全局消息条                                   → ::button "按钮" onClick=showToast toast-title="成功"

▎ 媒体
- 图片 ::image src=https://... alt="..." [w=400 h=300] [fit=cover|contain]
  └ 没现成 URL：::image gen="提示词" ratio=16:9（AI 文生图，3-10秒）
  └ 真实摄影：::image search="forest"（Pexels）
- 图标 ::icon star color=accent size=md（Lucide 库；mdi:foo 走 Iconify）
  何时用：metric 旁配语义图标（::icon trending-up + ::metric）、card/section 标题前做视觉锚点、feature 列表项前缀、空状态提示。
  常用名：star heart check x bell search user settings chart-line trending-up trending-down arrow-right sun moon cloud mail phone lock clock calendar。size: sm14/md18/lg24/xl32。
- 头像 ::avatar src=... name="张三" size=md
- 图片网格 ::gallery cols=3 gap=md + ::image 子项

▎ 文字 / 版式
- 标题 ::h1/h2/h3 "..."
- 段落 ::text "..."
- 富文本 ::md（多行 markdown 在子内容里）
- 引用 ::quote "引用文字" cite="出处"
- 关键句 ::editorial-pullquote "..."（杂志风左色条大字）
- 章节编号 ::chapter "1" title="标题"
- 巨号 display ::display "巨号标题"（适合 PPT 风首屏）
- 钩子小前缀 ::kicker "PHASE 01 · ..."
- 标签 ::tag "..." color=accent ｜ 徽章 ::badge "99+" color=danger

▎ 表单
- 文本输入 ::field "标签" name=foo placeholder="..." [required]
- 多行 ::textarea "标签" name=foo rows=3
- 下拉 ::select "标签" name=role options="管理员|admin,编辑|editor"
- 多选/单选 ::checkbox "记住我" name=remember checked ｜ ::radio "选项" name=plan value=a
- 开关 ::switch "记住我" name=remember checked
- 滑块 ::slider "评分" name=score min=0 max=10 value=5
- 日期 ::date "生日" name=birthday type=date|time|datetime
- 评分 ::rating "评分" name=stars max=5 value=4
- 上传 ::upload "文件" name=avatar accept="image/*" upload=demoUpload maxSize=5
- 提交按钮 ::button "提交" type=submit v=primary
- 表单容器 ::form onSubmit=submitForm 包以上字段
- 选择题/测验 ::quiz "标题" + ::option "选项" score=N

▎ 自带行为（AI 只声明，行为已封装）
- 标签页 ::tabs v=underline|pill + ::tab "标题"
- 横滑卡片 ::swiper gap=md + 任意子项
- 自动轮播 ::carousel interval=3000 + 子项
- 折叠面板 ::accordion + ::item "标题" [open]

▎ 布局
- ::card "标题" v=outline|highlight|default → 包装容器
- ::row + ::col span=N（1-12 grid）→ 不等宽分栏
- ::grid cols=N gap=md → 等宽 N 列（子项**不要**套 ::col）
  └ 响应式 cols-md=3 cols-sm=2 cols-xs=1
- ::section "副标题" → 卡片内分块
- ::divider → 横向分隔

▎ 易混组件怎么选（别在等价组件里随机挑）
- 强调一段带标题的要点 → ::callout（左色条 + 标题 + 描述）；短消息提示 → ::alert（图标 + 一句话）；纯引用 → ::quote
- 流程类：编号步骤条 → ::steps；阶梯式排期/递进感 → ::stairs；SVG 节点连线机制图 → ::mechanism
- 数字类：方块大字+描述+趋势 → ::metric；单行紧凑胶囊 → ::pill；环形百分比 → ::ring；线性进度 → ::progress
- 对比：A/B 带居中 VS → ::compare；自由不等宽分栏 → ::row+::col
- 标题层级：::h1 > ::h2 > ::h3（正文标题）；::display（PPT 风巨号首屏）；::chapter（带编号的章节）

▎ 常见组合模式
- 仪表盘卡片：::card > ::row > ::col span=8 + ::line / ::col span=4 + ::metric
- 图文混排：::row > ::col span=5 + ::image / ::col span=7 + ::text + ::callout
- 特性网格：::grid cols=3 > 每格 ::card v=outline + ::icon + ::text
- 数据+解读：::table / ::line 后跟 ::callout 总结要点
- 多 tab 看板：::tabs > 每个 ::tab 包一个 ::card + 图表

▎ 变体语义
- ::card v=default（标准白底）/ v=outline（轻量边框，次级信息）/ v=highlight（accent 强调，主结论）
- ::tabs v=underline（正式/数据看板）/ v=pill（轻松/胶囊，移动端友好）
- ::alert type=info/success/warn/danger（语义色 + 对应图标）
- ::button v=primary（主操作）/ v=ghost（次操作）/ v=outline（描边）

▎ 文本长度适配（重要——长文字别塞短文本组件）
- **只适合短文本/数值**（长了会撑破或截断）：::metric（大数字+单位）、::pill（短数+短标签）、::trend（百分比）、::tag（2-4字标签）、::badge（计数如"99+"）、::ring（中心百分比）、::tab（2-4字）、::kicker（短前缀）、::button（短按钮文字）、::rank name（长会被省略号截断）
- **适合中等文本**（一两句话）：::alert（一句话提示）、::callout desc（一句话描述）、::step desc（一句话）、::stairs desc
- **适合长文本**（段落/多行）：::text（正文段落）、::md（富文本，支持 markdown 语法在子内容）、::quote（引用段）、::editorial-summary（总结段）、::editorial-pullquote（关键句）
- **长内容别硬塞 ::metric/::pill**——比如「月活跃用户数达到一万两千三百四十五点六七万」这种长句该用 ::text，不是 ::metric。::metric 只放 "1234.67万" 这种精简数值。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【主题 & 配色】
内置主题：warm-amber / liquid-glass / gold / swiss / ink / indigo / forest / kraft / dune / huajuan。AI 不操心颜色，宿主切主题。若答案需要独立色调 → ::palette 写在 zone 块开头，局部染色。

【交互】
- 事件名全词：onClick / onChange / onInput / onSubmit
- 值是宿主注册的 handler 名字符串，DSL 里没有可执行代码
- 内置 demo handler：copyMsg / refresh / toggleSelect / logClick / logChange / toggleChecked / submitForm / showToast / demoUpload

【响应式（自动，AI 别操心）】
- ::col span=N 手机自动塌缩满宽
- ::grid cols=N 手机自动 1 列
- 精细控制：::grid cols=4 cols-md=3 cols-sm=2 cols-xs=1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【你是 agent，可主动调工具】
- web_search(query, max_results?) — 联网检索。涉及最新新闻/事件/数据/产品发布/人物动态必须先调，禁瞎编
- fetch_url(url) — 深读 web_search 给的链接
- generate_image(prompt, ratio?, size?) — agnes 文生图。创意/抽象/概念图用。返回 URL 后写 ::image src=<url>
- pexels_search(query, per_page?) — 真实摄影图。风景/人物/产品用，英文 query 效果好。返回 URL 后写 ::image src=<url>
原则：不确定就调，宁可多搜一次别瞎答；拿到 URL 直接 ::image src=<url>，别写 gen=/search=

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【反 slop（设计感底线）】
❌ 紫渐变 / emoji 当图标 / 圆角卡左 border accent / SVG 手画人脸/产品场景 / 散落 hex
✅ color 用 token；自定义配色用 ::palette；配图用 generate_image 或 pexels_search 真图；
✅ 每个元素 earn its place。注意区分：
   - data slop = 无用数字/进度条装饰 → 禁
   - iconography slop = **每个**标题都配 icon（信息冗余）→ 禁；但 metric 旁、feature 列表、空状态等**语义位置**配 icon 是加分，鼓励
   - gradient slop = 所有背景都渐变 → 禁

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【输出节奏】
- 先一句 markdown 文字提纲挈领，再 \`\`\`zone 块呈现数据
- 多行嵌套必须围栏；单行 ::metric / ::alert 可裸写穿插文字段
- ::palette 写在 zone 块开头，先到达后续才染色
- 图表先用封装组件（::line/::bar/::pie/::radar），不够才 option:，再不够才 ::echarts-raw`;

// ===== ZoneDSL Agent — multi-turn tool calling over Agnes (OpenAI compat) =====
// LLM 自主决定何时调用工具，最多 MAX_TURNS 轮（防失控），每轮 tool_result 截断
// 到 TOOL_RESULT_LIMIT 字节（防上下文爆炸）。
//
// 工具集：
//   web_search(query)        — Tavily 联网检索
//   fetch_url(url)           — Tavily extract 抓取并阅读单个 URL
//   generate_image(prompt, ratio?, size?)  — Agnes 文生图
//   pexels_search(query)     — Pexels 真实摄影
//
// 流式协议（追加到原有 {text,done,error}）：
//   {type:'tool_call', id, name, args}
//   {type:'tool_result', id, name, summary}
//   {type:'tool_error', id, name, message}

const MAX_TURNS = 5;
const TOOL_RESULT_LIMIT = 8 * 1024;   // 8KB per tool_result

// Tool registry — name → { schema (OpenAI tool def), exec(args) → string summary for LLM }
const ZONE_TOOLS = {
  web_search: {
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网检索实时信息。用于回答涉及最新新闻、事件、数据、人物、产品发布等需要联网核实的问题。query 里**不要**带过期年份（如 "2023"/"2024"），用 system prompt 给的当前日期；要查"最近 X"用当前年份。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词。中文或英文均可，越具体越好。日期相关问题用当前年份（见 system 当前时间），别用训练截止年份。' },
            max_results: { type: 'integer', description: '返回结果数，默认 5，最多 10', default: 5 },
          },
          required: ['query'],
        },
      },
    },
    async exec({ query, max_results }) {
      const data = await tavilySearch({ query, max_results: Math.min(Number(max_results) || 5, 10), include_answer: true });
      const lines = [];
      if (data.answer) lines.push(`摘要：${data.answer}`);
      (data.results || []).forEach((r, i) => {
        lines.push(`[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 400)}`);
      });
      return lines.join('\n\n') || '（无结果）';
    },
  },
  fetch_url: {
    schema: {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: '抓取并深读单个 URL 的正文（用 Tavily extract）。web_search 给了链接后想读全文用这个。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '要抓取的完整 URL' } },
          required: ['url'],
        },
      },
    },
    async exec({ url }) {
      if (!TAVILY_API_KEY) throw new Error('TAVILY_API_KEY not set');
      const r = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: [url] }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Tavily extract ${r.status}`);
      const content = data?.results?.[0]?.raw_content || data?.results?.[0]?.content || '';
      return content || '（无正文）';
    },
  },
  generate_image: {
    schema: {
      type: 'function',
      function: {
        name: 'generate_image',
        description: '调用 agnes 文生图生成图片。用于创意插画、概念图、抽象表达。返回图片 URL，AI 应将 URL 写进 ::image src=<url>。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述，越具体越好' },
            ratio: { type: 'string', description: '宽高比 1:1/16:9/9:16/4:3/3:4/3:2/2:3/21:9，默认 16:9' },
            size: { type: 'string', description: '清晰度 1K/2K/3K/4K，默认 1K' },
          },
          required: ['prompt'],
        },
      },
    },
    async exec({ prompt, ratio, size }) {
      const r = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt,
          size: size || '1K',
          ratio: ratio || '16:9',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Agnes image ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
      const url = data?.data?.[0]?.url || data?.url;
      if (!url) throw new Error('no image url');
      return `图片已生成，URL: ${url}\n用法：::image src=${url} alt="${prompt.slice(0, 40)}"`;
    },
  },
  pexels_search: {
    schema: {
      type: 'function',
      function: {
        name: 'pexels_search',
        description: 'Pexels 免费真实摄影图库搜图。用于需要真实照片的场景（风景/人物/产品/场景）。返回前几张图 URL。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，英文效果最好' },
            per_page: { type: 'integer', description: '返回数量，默认 3', default: 3 },
          },
          required: ['query'],
        },
      },
    },
    async exec({ query, per_page }) {
      if (!PEXELS_API_KEY) throw new Error('PEXELS_API_KEY not set');
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Number(per_page) || 3}`, {
        headers: { 'Authorization': PEXELS_API_KEY },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Pexels ${r.status}`);
      const photos = (data?.photos || []).map(p => ({
        url: p?.src?.large2x || p?.src?.large || p?.src?.original,
        alt: p?.alt || '',
      }));
      if (!photos.length) return '（无结果）';
      return photos.map((p, i) => `[${i + 1}] ${p.alt}\n::image src=${p.url}`).join('\n\n');
    },
  },
};

function truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + `…（已截断 ${str.length - n} 字节）` : str;
}

app.post('/api/zone', async (req, res) => {
  const { messages, model: requestModel } = req.body;
  const model = requestModel || MODEL;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_KEY not set in .env' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Conversation grows across turns: starts with system + user messages,
  // appends assistant tool_calls and tool results between turns.
  const convo = [
    { role: 'system', content: `${ZONE_SYSTEM_PROMPT}${getBusinessFormsPromptSection()}\n\n【当前时间】${getNowContext()}\n用户说「最近」「今天」「上周」等相对时间时以此为锚点；web_search 时也用这个日期范围。` },
    ...messages,
  ];
  const tools = Object.values(ZONE_TOOLS).map(t => t.schema);

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const isLast = turn === MAX_TURNS - 1;
      const payload = {
        model,
        stream: true,
        max_tokens: 8000,
        messages: convo,
        // On the last allowed turn, force a final answer (no more tools).
        ...(isLast ? {} : { tools, tool_choice: 'auto' }),
      };

      const upstream = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => '');
        send({ type: 'error', message: `Agnes HTTP ${upstream.status}: ${txt.slice(0, 200)}` });
        res.end();
        return;
      }

      // Stream this turn — accumulate assistant text + tool_calls (indexed delta merge).
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let assistantText = '';
      const toolCallAcc = {};   // index → { id, name, args (string accumulator) }
      let finishReason = null;
      let usage = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (line === '[DONE]') { buf = ''; break streamLoop; }
          let evt;
          try { evt = JSON.parse(line); } catch (_) { continue; }
          const choice = evt?.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            assistantText += delta.content;
            send({ type: 'text', delta: delta.content });
          }
          // GLM/qwen 等模型的思考链字段，转发给前端做「思考态」可视化
          if (delta?.reasoning_content) {
            send({ type: 'reasoning', delta: delta.reasoning_content });
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCallAcc[i]) toolCallAcc[i] = { id: '', name: '', args: '' };
              if (tc.id) toolCallAcc[i].id = tc.id;
              if (tc.function?.name) toolCallAcc[i].name = tc.function.name;
              if (tc.function?.arguments) toolCallAcc[i].args += tc.function.arguments;
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (evt?.usage) usage = evt.usage;
        }
      }

      const toolCalls = Object.values(toolCallAcc);
      // If model produced no tool calls, we're done.
      if (finishReason !== 'tool_calls' || !toolCalls.length) {
        send({ type: 'done', usage, turns: turn + 1 });
        res.end();
        return;
      }

      // Append assistant message with tool_calls to convo for next turn.
      convo.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      // Execute every tool call (sequentially — small N, simpler error handling).
      for (const tc of toolCalls) {
        const def = ZONE_TOOLS[tc.name];
        let args = {};
        try { args = tc.args ? JSON.parse(tc.args) : {}; } catch (_) {}
        send({ type: 'tool_call', id: tc.id, name: tc.name, args });
        let resultStr;
        try {
          if (!def) throw new Error(`unknown tool: ${tc.name}`);
          resultStr = await def.exec(args);
          resultStr = truncate(resultStr, TOOL_RESULT_LIMIT);
          send({ type: 'tool_result', id: tc.id, name: tc.name, summary: resultStr.slice(0, 200) });
        } catch (e) {
          resultStr = `Error: ${e?.message || String(e)}`;
          send({ type: 'tool_error', id: tc.id, name: tc.name, message: resultStr });
        }
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: resultStr,
        });
      }
      // Loop — next turn lets LLM see tool results and continue.
    }

    // Fell off the loop without final answer — emit a soft done.
    send({ type: 'done', exhausted: true, turns: MAX_TURNS });
    res.end();
  } catch (err) {
    console.error('[zone agent error]', err);
    send({ type: 'error', message: err?.message ?? String(err) });
    res.end();
  }
});

// ===== Image generation — 给组件层 ::image gen= 用的端点 =====
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// POST /api/image  { prompt, size?, ratio? } → { url }
app.post('/api/image', async (req, res) => {
  const { prompt, size, ratio } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not set' });
  try {
    const r = await fetch(`${BASE_URL}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        ...(size ? { size } : {}),
        ...(ratio ? { ratio } : {}),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: `Agnes image ${r.status}`, detail: data });
    const url = data?.data?.[0]?.url || data?.url;
    if (!url) return res.status(502).json({ error: 'no image url in response', detail: data });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/search  { query, max_results?, search_depth?, include_answer? }
// → { answer, results: [{title, url, content, score}] }
// Tavily AI-friendly web search. Used both standalone and as auto-context for /api/zone.
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
async function tavilySearch({ query, max_results = 5, search_depth = 'basic', include_answer = true }) {
  if (!TAVILY_API_KEY) throw new Error('TAVILY_API_KEY not set');
  if (!query) throw new Error('query required');
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results,
      search_depth,
      include_answer,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

app.post('/api/search', async (req, res) => {
  try {
    const data = await tavilySearch(req.body || {});
    res.json({
      answer: data?.answer || null,
      results: (data?.results || []).map(r => ({
        title: r.title, url: r.url, content: r.content, score: r.score,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/pexels?query=...&per_page=... → { photos: [{url, alt, photographer}] }
app.get('/api/pexels', async (req, res) => {
  const { query, per_page } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });
  if (!PEXELS_API_KEY) return res.status(500).json({ error: 'PEXELS_API_KEY not set' });
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Number(per_page) || 5}`, {
      headers: { 'Authorization': PEXELS_API_KEY },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: `Pexels ${r.status}`, detail: data });
    const photos = (data?.photos || []).map(p => ({
      url: p?.src?.large2x || p?.src?.large || p?.src?.original,
      alt: p?.alt || '',
      photographer: p?.photographer || '',
    }));
    res.json({ photos });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ===== 业务组件协议（host-defined forms） =====
// 单一来源：后端注册业务表单的「字段 schema + 触发场景 + 提交 endpoint」。
// 1. server 启动时把清单拼进 ZONE_SYSTEM_PROMPT 让 AI 知道何时调用
// 2. 暴露 /api/business-forms 让前端 ::business-form 组件按 name 拉 schema
// 3. /api/business-forms/:name/submit 接收表单提交，路由到对应业务 endpoint
//
const BUSINESS_FORMS = {
  'user-edit': {
    desc: '修改个人资料',
    trigger: '用户要改自己的昵称/头像/简介',
    fields: [
      { name: 'nickname', label: '昵称', type: 'text', required: true, placeholder: '2-20 字' },
      { name: 'avatar', label: '头像', type: 'upload', accept: 'image/*' },
      { name: 'bio', label: '个人简介', type: 'textarea', rows: 2 },
    ],
    submitLabel: '保存',
    submit: async (data) => {
      console.log('[business-form] user-edit submitted:', data);
      return { ok: true, message: '资料已更新' };
    },
  },
};

// 给 AI 看见的「当前时间」上下文，LLM 训练截止后没法自己知道今天是哪天，
// 不塞这个，它解读「最近」「上周」会用训练截止日期当锚点，体感时间错位。
function getNowContext() {
  const d = new Date();
  const dateStr = d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    timeZone: 'Asia/Shanghai',
  });
  const timeStr = d.toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Shanghai',
  });
  return `${dateStr} ${timeStr}（北京时间）`;
}

function getBusinessFormsPromptSection() {
  const names = Object.keys(BUSINESS_FORMS);
  if (!names.length) return '';
  const lines = ['', '【可用业务组件（接业务后端，字段已固化，AI 一行调用即可）】'];
  for (const name of names) {
    const def = BUSINESS_FORMS[name];
    lines.push(`- ::business-form name=${name}  → ${def.desc}（触发：${def.trigger}）`);
  }
  lines.push('原则：用户**明确要做这些业务动作**时，直接写 ::business-form name=xxx 一行，');
  lines.push('不要自己用 ::form + ::field 重造表单——字段名跟后端对不齐会出错。');
  return lines.join('\n');
}

app.get('/api/business-forms', (_req, res) => {
  const list = Object.entries(BUSINESS_FORMS).map(([name, def]) => ({
    name, desc: def.desc, trigger: def.trigger,
    fields: def.fields, submitLabel: def.submitLabel || '提交',
  }));
  res.json({ forms: list });
});

app.post('/api/business-forms/:name/submit', async (req, res) => {
  const def = BUSINESS_FORMS[req.params.name];
  if (!def) return res.status(404).json({ error: 'unknown business form' });
  try {
    const result = await def.submit(req.body || {});
    res.json(result || { ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

setupPromaxAPI(app);

// ===== 用户主题持久化（SQLite）=====
const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const DB_PATH = path.join(DATA_DIR, 'user-themes.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS palettes (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS palette_history (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  seed TEXT,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_palette_history_created ON palette_history(created_at DESC)`);
db.exec(`CREATE TABLE IF NOT EXISTS theme_history (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  seed TEXT,
  has_image INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_theme_history_created ON theme_history(created_at DESC)`);

// 一次性迁移：如果存在旧的 user-themes.json，导入后归档
const LEGACY_PATH = path.join(DATA_DIR, 'user-themes.json');
if (fs.existsSync(LEGACY_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    const list = Array.isArray(raw?.themes) ? raw.themes : [];
    const insert = db.prepare('INSERT OR IGNORE INTO themes (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    const tx = db.transaction((arr) => {
      for (const t of arr) {
        if (!t?.id) continue;
        insert.run(t.id, JSON.stringify(t), t.createdAt || now, t.updatedAt || now);
      }
    });
    tx(list);
    fs.renameSync(LEGACY_PATH, LEGACY_PATH + '.migrated');
    console.log(`[user-themes] imported ${list.length} from JSON → SQLite, archived legacy file`);
  } catch (e) {
    console.warn('[user-themes] legacy import failed:', e.message);
  }
}

function listThemes() {
  const rows = db.prepare('SELECT json FROM themes ORDER BY updated_at DESC').all();
  return rows.map((r) => JSON.parse(r.json));
}
function upsertTheme(theme) {
  const now = Date.now();
  const stored = { ...theme, createdAt: theme.createdAt ?? now, updatedAt: now };
  db.prepare(`INSERT INTO themes (id, json, created_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
    .run(stored.id, JSON.stringify(stored), stored.createdAt, stored.updatedAt);
  return stored;
}
function deleteTheme(id) {
  return db.prepare('DELETE FROM themes WHERE id = ?').run(id).changes;
}

app.get('/api/user-themes', (_req, res) => {
  res.json({ themes: listThemes() });
});
app.post('/api/user-themes', (req, res) => {
  const theme = req.body;
  if (!theme || !theme.id || !theme.tokens) {
    return res.status(400).json({ error: 'theme requires id + tokens' });
  }
  const stored = upsertTheme(theme);
  const count = db.prepare('SELECT COUNT(*) AS n FROM themes').get().n;
  res.json({ ok: true, theme: stored, count });
});
app.delete('/api/user-themes/:id', (req, res) => {
  const removed = deleteTheme(req.params.id);
  res.json({ ok: true, removed });
});

// ===== 用户色卡 CRUD =====
function listPalettes() {
  const rows = db.prepare('SELECT json FROM palettes ORDER BY updated_at DESC').all();
  return rows.map((r) => JSON.parse(r.json));
}
function upsertPalette(p) {
  const now = Date.now();
  const stored = { ...p, createdAt: p.createdAt ?? now, updatedAt: now };
  db.prepare(`INSERT INTO palettes (id, json, created_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
    .run(stored.id, JSON.stringify(stored), stored.createdAt, stored.updatedAt);
  return stored;
}
function deletePalette(id) {
  return db.prepare('DELETE FROM palettes WHERE id = ?').run(id).changes;
}

app.get('/api/user-palettes', (_req, res) => {
  res.json({ palettes: listPalettes() });
});
app.post('/api/user-palettes', (req, res) => {
  const p = req.body;
  if (!p || !p.id || !p.color) {
    return res.status(400).json({ error: 'palette requires id + color' });
  }
  const stored = upsertPalette(p);
  res.json({ ok: true, palette: stored });
});
app.delete('/api/user-palettes/:id', (req, res) => {
  res.json({ ok: true, removed: deletePalette(req.params.id) });
});

// ===== 调色历史（最近 100 条，去重）=====
function paletteHash(pal) {
  // 用主要 6 个色拼一个稳定 hash
  const c = pal?.color || {};
  return [c.accent, c.accentLight, c.accentSoft, c.accentDeep, c.bg, c.text].join('|').toLowerCase();
}
function insertHistory(pal, seed) {
  const hash = paletteHash(pal);
  if (!hash || hash.length < 20) return;  // 防止空 palette 入库
  const stored = { ...pal, seed, createdAt: Date.now() };
  db.prepare(`INSERT OR REPLACE INTO palette_history (hash, json, seed, created_at) VALUES (?, ?, ?, ?)`)
    .run(hash, JSON.stringify(stored), seed || null, stored.createdAt);
  // 修剪到 100 条
  db.prepare(`DELETE FROM palette_history WHERE hash NOT IN (
    SELECT hash FROM palette_history ORDER BY created_at DESC LIMIT 100
  )`).run();
}
app.get('/api/palette-history', (_req, res) => {
  const rows = db.prepare('SELECT json FROM palette_history ORDER BY created_at DESC LIMIT 100').all();
  res.json({ palettes: rows.map(r => JSON.parse(r.json)) });
});
app.delete('/api/palette-history', (_req, res) => {
  db.prepare('DELETE FROM palette_history').run();
  res.json({ ok: true });
});

// ===== 主题生成历史 =====
function themeHash(t) {
  const c = t?.tokens || {};
  return [t?.id, c.accent, c.bg, c.text, (t?.layoutCss || '').slice(0, 40)].join('|').toLowerCase();
}
function insertThemeHistory(theme, seed, hasImage) {
  const hash = themeHash(theme);
  if (!hash || hash.length < 10) return;
  const stored = { ...theme, seed, hasImage: !!hasImage, createdAt: Date.now() };
  db.prepare(`INSERT OR REPLACE INTO theme_history (hash, json, seed, has_image, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hash, JSON.stringify(stored), seed || null, hasImage ? 1 : 0, stored.createdAt);
  db.prepare(`DELETE FROM theme_history WHERE hash NOT IN (
    SELECT hash FROM theme_history ORDER BY created_at DESC LIMIT 100
  )`).run();
}
app.get('/api/theme-history', (_req, res) => {
  const rows = db.prepare('SELECT json FROM theme_history ORDER BY created_at DESC LIMIT 100').all();
  res.json({ themes: rows.map(r => JSON.parse(r.json)) });
});
app.delete('/api/theme-history', (_req, res) => {
  db.prepare('DELETE FROM theme_history').run();
  res.json({ ok: true });
});

// ===== 看图生成主题 =====
// 入参：{ imageBase64, mediaType, hint? }
// 出参：流式 JSON（最终一段是完整 theme spec）
const THEME_GEN_SYSTEM_PROMPT = `你是一位资深视觉设计师，专精中文公众号 / 小红书 / 编辑级别的卡片排版。

任务：分析用户上传的图片，输出一个完整的 markdown 主题设计 token，能在 Web 上重现这张图的视觉感觉。

# 输出要求（严格 JSON，禁止 markdown 包裹，禁止注释）

必须输出一个 JSON 对象，包含字段：
{
  "id": "auto-<6 位随机后缀>",            // 必填，全英小写
  "name": "<2-6 字中文短名>",              // 必填
  "desc": "<10 字内一句描述>",
  "category": "social" | "editorial" | "document",   // 自动选最贴近一类
  "tokens": {
    "accent":        "#xxxxxx",   // 主色
    "accentLight":   "#xxxxxx",   // 浅色（10% 主色）
    "accentSoft":    "#xxxxxx",   // 极浅（5% 主色）
    "accentDeep":    "#xxxxxx",   // 深色（70% 主色）
    "bg":            "#xxxxxx",   // 页面背景
    "panel":         "#xxxxxx",   // 卡片/段落底色
    "text":          "#xxxxxx",   // 主文字
    "textSecondary": "#xxxxxx",   // 副文字
    "border":        "#xxxxxx"    // 边线
  },
  "typography": {
    "heading": "<CSS font-family 字符串，含 fallback>",
    "body":    "<CSS font-family 字符串，含 fallback>"
  },
  "layoutCss": "<CSS 字符串>",       // 用 .markdown-body 作根选择器；可写 .markdown-body h1 {...} 等
  "rationale": "<30 字内说明视觉风格判断>"
}

# layoutCss 写作约定（重要）

1. 用 token 变量：颜色用 var(--accent) / var(--accent-light) / var(--accent-soft) / var(--accent-deep) / var(--bg) / var(--text) / var(--text-secondary) / var(--border)
2. 字体用 var(--font-heading) / var(--font-body)（已被 typography 字段触发）
3. 禁止硬编码彩色（除非给装饰角标/插画式 emoji）；纯黑白灰可用
4. 必须包含规则：.markdown-body / h1 / h2 / h3 / p / blockquote / strong / em / ul / ol / li / hr
5. 风格大胆：标题可用 inline-block + 背景胶囊 / 圆勾 / 数字徽章 / 涂鸦笔刷（用 linear-gradient 模拟）/ 双线下划线
6. 移动端宽度（max-width 480-560px，margin: 0 auto），文字 14-16px 行距 1.8
7. CSS 必须能直接 cssText 注入，不依赖外部图片资源

# 决策原则

- 看清图片的：底色（背景）/ 主色（标题、强调）/ 副色 / 字体感觉（衬线 vs 黑体 vs 圆体）/ 标题装饰风格（胶囊 / 圆勾 / 大数字 / 笔刷 / 边框）
- 直接以图片为参考，颜色尽量贴近原图
- WCAG：text 与 bg 对比度 ≥ 4.5
- accent 和 bg 至少有明显色相差异
- typography heading 与 body 可同一字体，但 heading 一定要 700+ weight
- name 必须中文，体现风格（如「樱花日报」「金融蓝皮书」「学霸学习卡」）

# 仅输出 JSON

不要任何额外文字、不要 markdown 代码块、不要 \`\`\`json，纯 JSON 对象。`;

app.post('/api/theme-gen', async (req, res) => {
  const { imageBase64, mediaType, hint } = req.body || {};
  // 至少要有一项输入：图片 或 文字描述
  if (!imageBase64 && !hint?.trim()) {
    return res.status(400).json({ error: '需要提供图片或文字描述' });
  }
  console.log('[theme-gen] start, mode:', imageBase64 ? 'image+text' : 'text-only', 'hint:', hint || '(none)');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let acc = '';
  const startedAt = Date.now();
  try {
    const userContent = [];
    if (imageBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 },
      });
      userContent.push({
        type: 'text',
        text: hint
          ? `用户补充说明：${hint}\n\n请分析这张图（结合用户说明），输出完整 markdown 主题 JSON（严格按 schema）。`
          : '请分析这张图，输出完整 markdown 主题 JSON（严格按 schema）。',
      });
    } else {
      // 纯文字模式
      userContent.push({
        type: 'text',
        text: `用户描述了想要的主题感觉：\n\n${hint}\n\n请基于这段描述凭空设计一套完整的 markdown 主题 JSON（严格按 schema）。要让视觉风格、配色、字体、layout CSS 都贴合描述。`,
      });
    }

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: THEME_GEN_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: userContent }],
    });

    stream.on('text', (delta) => {
      acc += delta;
      send({ type: 'text', delta });
    });
    stream.on('error', (err) => send({ type: 'error', message: err?.message ?? String(err) }));

    const final = await stream.finalMessage();
    // 尽量从 acc 中提取 JSON（容错：去除可能的 ```json 包裹）
    let cleaned = acc.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      // 试着抓最外层 {...}
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parseError = e2.message; } }
      else parseError = e.message;
    }
    console.log('[theme-gen] done in', Date.now()-startedAt, 'ms, chars:', acc.length, 'parseError:', parseError || 'none');
    if (parsed && parsed.id) {
      try { insertThemeHistory(parsed, hint, !!imageBase64); } catch (e) { console.warn('[theme-history] insert failed:', e.message); }
    }
    send({ type: 'done', theme: parsed, parseError, stop_reason: final.stop_reason, usage: final.usage });
    res.end();
  } catch (err) {
    console.error('[theme-gen error]', err?.message || err);
    send({ type: 'error', message: err?.message ?? String(err) });
    res.end();
  }
});

// ===== 灵感提示词生成（用便宜模型，给用户填进描述输入框）=====
const PROMPT_GEN_SYSTEM = `你是一位资深视觉设计师。任务：给出一句中文的「主题灵感描述」，让另一个 AI 用来生成 markdown 阅读主题。

要求：
- 一句话，30~60 字
- 包含：行业 / 场景 + 风格倾向 + 主色 + 排版气质
- 风格要新颖、有画面感、避免重复套路（不要总是杂志/小红书）
- 不要解释，不要加引号，直接输出这句话本身`;

const PROMPT_GEN_MODEL = process.env.PROMPT_GEN_MODEL || 'aws/claude-haiku-4-5';

app.post('/api/theme-prompt-gen', async (req, res) => {
  try {
    const seed = req.body?.seed || '';
    const userText = seed
      ? `用户给的种子方向：${seed}\n请围绕它给一句新的主题描述。`
      : '随机给一句主题灵感描述。每次要不一样。';
    const resp = await client.messages.create({
      model: PROMPT_GEN_MODEL,
      max_tokens: 200,
      system: PROMPT_GEN_SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content?.[0]?.text || '').trim().replace(/^["'「]|["'」]$/g, '');
    console.log('[prompt-gen] ->', text);
    res.json({ ok: true, prompt: text });
  } catch (err) {
    console.error('[prompt-gen] failed:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

// ===== AI 色卡生成 =====
const PALETTE_GEN_SYSTEM = `你是一位资深平面设计师，擅长调色。

任务：根据用户给的风格/情绪关键词，输出 N 套完整的 markdown 主题配色 palette。每套配色都要在浅底深字的阅读场景下成立。

严格输出 JSON 数组，每个元素：
{
  "name": "中文短名（4-8 字）",
  "desc": "一句话风格描述（10-20 字）",
  "color": {
    "accent":        "#xxxxxx", // 主品牌色，标题/强调
    "accentLight":   "#xxxxxx", // accent 的 12%-20% 浅化
    "accentSoft":    "#xxxxxx", // 更浅的衬底，6%-10%
    "accentDeep":    "#xxxxxx", // accent 的加深，hover/重音
    "bg":            "#xxxxxx", // 页面底色（必须够浅，能放黑字）
    "panel":         "#ffffff", // 卡片底色（一般白）
    "text":          "#xxxxxx", // 正文颜色（够深，与 bg 对比 >= 7:1）
    "textSecondary": "#xxxxxx", // 二级文字（灰色）
    "border":        "#xxxxxx"  // 分割线（浅灰）
  }
}

规则：
- 所有颜色用 6 位 hex（小写）
- 每套 palette 在视觉上要明显不同（色相至少 60 度差或亮度差 20%）
- bg 必须 >= L*85（保证浅底）
- text 必须 <= L*30（保证深字）
- 输出 6 套不同的 palette
- 禁止 markdown 包裹，禁止注释，直接输出 JSON 数组`;

const PALETTE_GEN_MODEL = process.env.PALETTE_GEN_MODEL || 'aws/claude-haiku-4-5';

app.post('/api/palette-gen', async (req, res) => {
  try {
    const seed = (req.body?.seed || '').trim();
    const count = Math.max(3, Math.min(8, Number(req.body?.count) || 6));
    const imageBase64 = req.body?.imageBase64;
    const mediaType = req.body?.mediaType || 'image/png';
    if (!seed && !imageBase64) {
      return res.status(400).json({ ok: false, error: '需要文字关键词或参考图' });
    }
    console.log('[palette-gen]', imageBase64 ? `image+${seed||'(no-seed)'}` : 'text-only:'+seed, 'count:', count);
    const content = [];
    if (imageBase64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
      content.push({
        type: 'text',
        text: seed
          ? `参考这张图取色，结合关键词「${seed}」，输出 ${count} 套贴合图像主色但有差异化的 palette 的 JSON 数组。第一套要最接近图本身。`
          : `参考这张图取色，输出 ${count} 套贴合图像主色但有差异化的 palette 的 JSON 数组。第一套要最接近图本身。`,
      });
    } else {
      content.push({ type: 'text', text: `风格关键词：${seed || '随机一组现代感的配色'}\n\n请输出 ${count} 套 palette 的 JSON 数组。` });
    }
    const resp = await client.messages.create({
      model: imageBase64 ? MODEL : PALETTE_GEN_MODEL,  // 有图用 vision 模型（Opus）
      max_tokens: 2500,
      system: PALETTE_GEN_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    let raw = (resp.content?.[0]?.text || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let palettes;
    try { palettes = JSON.parse(raw); }
    catch (e) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) palettes = JSON.parse(m[0]);
      else throw e;
    }
    if (!Array.isArray(palettes)) throw new Error('返回不是数组');
    // 写入历史（去重 / 截断 100 条）
    try { palettes.forEach(p => insertHistory(p, seed)); } catch (e) { console.warn('[palette-history] insert failed:', e.message); }
    res.json({ ok: true, palettes });
  } catch (err) {
    console.error('[palette-gen] failed:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

// ===== 导出主题包（CSS + JS + README 打成 zip）=====
app.post('/api/export', (req, res) => {
  try {
    const themeIds = Array.isArray(req.body?.themeIds) ? req.body.themeIds : [];
    const includePalettes = !!req.body?.includePalettes;
    const namespaced = req.body?.namespaced !== false;  // 默认开启
    const headingInherit = !!req.body?.headingInherit;  // h3 继承 h1 样式
    if (themeIds.length === 0) return res.status(400).json({ error: '请至少选择一个主题' });
    const userThemes = listThemes();
    const userPalettes = includePalettes ? listPalettes() : [];
    const files = buildBundle(themeIds, { userThemes, userPalettes, namespaced, headingInherit });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="huajuan-themes-${Date.now()}.zip"`);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('[export] zip error:', err); res.end(); });
    archive.pipe(res);
    Object.entries(files).forEach(([name, content]) => {
      archive.append(Buffer.from(content, 'utf8'), { name });
    });
    archive.finalize();
    console.log('[export] bundled', themeIds.length, 'themes,', Object.keys(files).join('/'));
  } catch (err) {
    console.error('[export] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  花卷工厂 running at http://0.0.0.0:${PORT}\n`);
});
