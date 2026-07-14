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
import { buildBundle } from './export-themes.js';

// override: true so values in .env take precedence over inherited shell env
// (Claude Code's shell preloads API_KEY/BASE_URL for its own use).
dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.API_KEY && !process.env.API_AUTH_TOKEN) {
  console.warn('[warn] No API key in .env. Server starts, but AI features need key configured via UI (gear icon) or .env.');
}

const MODEL = process.env.AI_MODEL || 'agnes-2.0-flash';
const BASE_URL = process.env.API_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const MODELS_ENV = process.env.AI_MODELS
  ? process.env.AI_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : null;
const AUTH_TOKEN = process.env.API_AUTH_TOKEN;
const API_KEY = process.env.API_KEY;


console.log(`[config] model=${MODEL} baseURL=${BASE_URL} auth=${AUTH_TOKEN ? 'Bearer' : 'x-api-key'}`);

// ===== 每请求 AI 配置（界面用户可覆盖）=====
function getAIConfig(req) {
  const h = req?.headers || {};
  const apiKey = h['x-user-api-key'] || API_KEY;
  const baseUrl = h['x-user-base-url'] || BASE_URL;
  const model = h['x-user-model'] || MODEL;
  let format = h['x-user-format'] || 'auto';
  if (format === 'auto') {
    format = baseUrl.includes('anthropic') ? 'anthropic' : 'openai';
  }
  return { apiKey, baseUrl, model, format };
}

// ===== 统一 AI 调用（非流式）=====
async function callAI(config, { system, messages, maxTokens = 4096, model }) {
  const useModel = model || config.model;
  if (config.format === 'anthropic') {
    const c = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
    // 转换 messages：OpenAI content string → Anthropic content blocks
    const anthropicMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    }));
    const resp = await c.messages.create({
      model: useModel, max_tokens: maxTokens, system,
      messages: anthropicMessages,
    });
    return resp.content?.[0]?.text || '';
  } else {
    // OpenAI 兼容：system 转成 messages[0]
    const oaiMessages = [];
    if (system) oaiMessages.push({ role: 'system', content: typeof system === 'string' ? system : system.map(s => s.text || '').join('\n') });
    oaiMessages.push(...messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content
        : m.content.map(b => b.type === 'text' ? b.text : '').join(''),
    })));
    const r = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: useModel, messages: oaiMessages, max_tokens: maxTokens }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ===== 统一 AI 调用（流式）→ 回调 onDelta(text) =====
async function callAIStream(config, { system, messages, maxTokens = 16000, model }, onDelta) {
  const useModel = model || config.model;
  if (config.format === 'anthropic') {
    const c = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
    const anthropicMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    }));
    const stream = c.messages.stream({
      model: useModel, max_tokens: maxTokens, system, messages: anthropicMessages,
    });
    let fullText = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        onDelta(event.delta.text);
      }
    }
    return fullText;
  } else {
    const oaiMessages = [];
    if (system) oaiMessages.push({ role: 'system', content: typeof system === 'string' ? system : system.map(s => s.text || '').join('\n') });
    oaiMessages.push(...messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content
        : m.content.map(b => b.type === 'text' ? b.text : '').join(''),
    })));
    const r = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: useModel, messages: oaiMessages, max_tokens: maxTokens, stream: true }),
    });
    if (!r.ok) throw new Error(`OpenAI stream ${r.status}: ${await r.text()}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { fullText += delta; onDelta(delta); }
        } catch (_) {}
      }
    }
    return fullText;
  }
}

// JSONL chat log — one line per /api/chat call. Append-only daily file
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, baseURL: BASE_URL ?? null, models: MODELS_ENV });
});


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

    const cfg = getAIConfig(req);
    await callAIStream(cfg, {
      system: THEME_GEN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 4000,
    }, (delta) => {
      acc += delta;
      send({ type: 'text', delta });
    });
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
    const cfg = getAIConfig(req);
    const raw = await callAI(cfg, {
      system: PROMPT_GEN_SYSTEM,
      messages: [{ role: 'user', content: userText }],
      maxTokens: 200, model: PROMPT_GEN_MODEL,
    });
    const text = raw.trim().replace(/^["'「]|["'」]$/g, '');
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
    const cfg = getAIConfig(req);
    let raw = (await callAI(cfg, {
      system: PALETTE_GEN_SYSTEM,
      messages: [{ role: 'user', content }],
      maxTokens: 2500, model: imageBase64 ? MODEL : PALETTE_GEN_MODEL,
    })).trim();
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
  console.log(`\n  花卷实验室 running at http://0.0.0.0:${PORT}\n`);
});
