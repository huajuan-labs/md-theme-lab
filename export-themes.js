// 从 markdown-style.html 抽出主题数据 + CSS，给「导出主题包」用
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, 'public', 'markdown-style.html');

let cache = null;
function loadAll() {
  if (cache) return cache;
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  // 1. 抽 <style> 内全部 CSS
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  const css = styleMatch ? styleMatch[1] : '';

  // 2. :root token 默认值
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  const rootCss = rootMatch ? `:root {${rootMatch[1]}}` : '';

  // 3. 通用 markdown-body / 扩展元素样式（callout / highlight / md-toc）
  const commonChunks = [];
  // 通用 markdown-body 容器
  const bodyMatch = css.match(/\.markdown-body\s*\{[\s\S]*?\}/g) || [];
  bodyMatch.forEach(c => commonChunks.push(c));
  // 高亮 / callout / toc / katex / chart 等扩展规则
  const extPatterns = [
    /\.markdown-body mark\.md-highlight[\s\S]*?\}/g,
    /\.markdown-body \.md-callout[\s\S]*?\}/g,
    /\.md-callout[\s\S]*?\}/g,
    /\.markdown-body \.md-toc[\s\S]*?\}/g,
    /\.markdown-body \.md-toc-list[\s\S]*?\}/g,
    /\.markdown-body\s+[a-z]+[\s\S]*?\}/gi,  // 通用元素样式 ul/ol/blockquote 等（粗匹配）
  ];

  // 4. 每个 layout 的 CSS 块（layout-xxx 开头到下一个空行或下一个不同 selector 块）
  const layoutCssMap = {};
  // 抽 body.layout-xxx 单行
  const bodyLayoutRe = /(body\.layout-[a-z0-9-]+\s*\{[\s\S]*?\})/g;
  // 抽 .layout-xxx 选择器开始的所有规则
  // 不能用 lazy regex 抽 layout 块——某些规则字符串里有 `}`（如 content: ' }-'）会被误判截断
  // 改用栈式扫描，忽略字符串内的 `{` `}`
  const layoutBlocks = [];
  {
    const re = /\.layout-[a-z0-9-]+[^{]*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      const start = m.index;
      let i = m.index + m[0].length;
      let depth = 1;
      let inStr = false, strCh = '';
      while (i < css.length && depth > 0) {
        const ch = css[i];
        if (inStr) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === strCh) inStr = false;
        } else {
          if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
          else if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        i++;
      }
      layoutBlocks.push(css.slice(start, i));
      re.lastIndex = i;
    }
  }
  layoutBlocks.forEach(block => {
    const m = block.match(/\.layout-([a-z0-9-]+)/);
    if (!m) return;
    const layoutId = m[1];
    if (!layoutCssMap[layoutId]) layoutCssMap[layoutId] = [];
    layoutCssMap[layoutId].push(block);
  });
  // body.layout-xxx 字体绑定也并入对应 layout
  (css.match(bodyLayoutRe) || []).forEach(block => {
    const m = block.match(/body\.layout-([a-z0-9-]+)/);
    if (!m) return;
    const layoutId = m[1];
    if (!layoutCssMap[layoutId]) layoutCssMap[layoutId] = [];
    layoutCssMap[layoutId].unshift(block);
  });

  // 5. 抽 themes / palettes / labels (用 eval 在隔离作用域里执行)
  function extractObject(src, startTag, endChar) {
    const idx = src.indexOf(startTag);
    if (idx < 0) return null;
    // 找匹配的结束（栈式扫描）
    const startBracket = src.indexOf(endChar === '}' ? '{' : '[', idx);
    if (startBracket < 0) return null;
    const open = endChar === '}' ? '{' : '[';
    let depth = 0;
    let i = startBracket;
    let inStr = false, strCh = '';
    for (; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === open) depth++;
      else if (ch === endChar) {
        depth--;
        if (depth === 0) {
          return src.slice(startBracket, i + 1);
        }
      }
    }
    return null;
  }
  const themesSrc = extractObject(html, 'const themes = [', ']');
  const palettesSrc = extractObject(html, 'const palettes = {', '}');
  const layoutLabelsSrc = extractObject(html, 'const layoutLabels = {', '}');
  const colorLabelsSrc = extractObject(html, 'const colorLabels = {', '}');

  // eval 进对象（需要 buildPalette 函数支持）
  let themes = [], palettes = {}, layoutLabels = {}, colorLabels = {};
  try {
    const sandbox = `
      function buildPalette(p) {
        return {
          color: {
            accent: p.accent, accentLight: p.accentLight, accentSoft: p.accentSoft, accentDeep: p.accentDeep,
            bg: p.bg, panel: p.panel || '#ffffff', text: p.text,
            textSecondary: p.textSecondary || p.secondary || '#666666',
            border: p.border || '#e5e7eb',
          },
          meta: { mode: 'light', source: 'preset' },
        };
      }
      const themes = ${themesSrc};
      const palettes = ${palettesSrc};
      const layoutLabels = ${layoutLabelsSrc};
      const colorLabels = ${colorLabelsSrc};
      return { themes, palettes, layoutLabels, colorLabels };
    `;
    const fn = new Function(sandbox);
    const result = fn();
    themes = result.themes;
    palettes = result.palettes;
    layoutLabels = result.layoutLabels;
    colorLabels = result.colorLabels;
  } catch (e) {
    console.error('[export-themes] eval failed:', e.message);
  }

  cache = { css, rootCss, layoutCssMap, themes, palettes, layoutLabels, colorLabels };
  return cache;
}

// 构建主题包：传入要的 theme id 数组 + 可选用户主题/色卡 / 命名空间
export function buildBundle(themeIds, opts = {}) {
  const all = loadAll();
  const userThemes = opts.userThemes || [];
  const userPalettes = opts.userPalettes || [];
  const namespaced = opts.namespaced !== false;  // 默认开启隔离
  const headingInherit = !!opts.headingInherit;     // 标题层级继承：h1/h2/h3 共享 h1 样式

  // 合并用户主题到候选池（用户主题 layout 用自身 id 作为 layout id）
  const themePool = [...all.themes];
  const userPaletteMap = {};
  const userLayoutCss = {};
  userThemes.forEach(ut => {
    if (!ut?.id || !ut?.tokens) return;
    // 把 user theme 包装成标准 theme 形态
    themePool.push({
      id: ut.id,
      name: ut.name || ut.id,
      layout: ut.id,
      color: ut.id,
      source: 'ai-gen',
      desc: ut.desc || 'AI 生成',
    });
    // 把 tokens 转成 palette 形态
    userPaletteMap[ut.id] = {
      color: {
        accent: ut.tokens.accent,
        accentLight: ut.tokens.accentLight || ut.tokens.accent,
        accentSoft: ut.tokens.accentSoft || ut.tokens.bg,
        accentDeep: ut.tokens.accentDeep || ut.tokens.accent,
        bg: ut.tokens.bg,
        panel: ut.tokens.panel || '#ffffff',
        text: ut.tokens.text,
        textSecondary: ut.tokens.textSecondary || '#666666',
        border: ut.tokens.border || '#e5e7eb',
      },
      meta: { mode: 'light', source: 'ai-gen' },
    };
    // user layout CSS
    if (ut.layoutCss) {
      userLayoutCss[ut.id] = ut.layoutCss.replace(/\.markdown-body/g, `.layout-${ut.id} .markdown-body`);
    }
  });

  // 用户色卡（不绑 layout，独立可用）
  const userPaletteOnly = {};
  userPalettes.forEach(up => {
    if (!up?.id || !up?.color) return;
    userPaletteOnly[up.id] = { color: up.color, meta: { mode: 'light', source: 'user-palette', name: up.name } };
  });

  const wantedThemes = themePool.filter(t => themeIds.includes(t.id));
  if (wantedThemes.length === 0) throw new Error('没有匹配到任何主题');

  // 按分类给主题准备「快速换色」候选（跟前端 QUICK_COLOR_SETS 保持一致）
  const QUICK_COLOR_SETS = {
    editorial: ['warm','vintage','sunset','gold','rose','forest','deepsea','midnight'],
    document:  ['corporate','navy','slate','charcoal','sage','parchment','haze','newsprint'],
    social:    ['xhs-finance','xhs-study','xhs-hr','xhs-exam','xhs-blue-pill','xhs-numbered','xhs-festival','xhs-zen'],
    brand:     ['warm','corporate','midnight','rose','sage','charcoal','vintage','gold'],
    dark:      ['dark','midnight','charcoal','graphite','navy','violet','deepsea','berry'],
    warm:      ['warm','sunset','gold','rose','vintage','coral','caramel','terracotta'],
  };
  function quickColorsFor(t) {
    if (Array.isArray(t.colorVariants) && t.colorVariants.length) return t.colorVariants;
    const id = t.id || '';
    const lay = t.layout || '';
    if (id.startsWith('xhs-') || id.startsWith('fan-')) return QUICK_COLOR_SETS.social;
    if (id.startsWith('huasheng-') || t.source === 'huasheng') return QUICK_COLOR_SETS.brand;
    if (id.startsWith('briefing-') || lay === 'briefing') return QUICK_COLOR_SETS.document;
    if (['magazine','ppt','poster','wechat','newspaper'].includes(lay)) return QUICK_COLOR_SETS.editorial;
    if (['minimal','academic','checklist','timeline','comparison'].includes(lay)) return QUICK_COLOR_SETS.document;
    return [];
  }

  // 收集涉及的 layout（按主题选择走）+ color（全量带上，体积小、用法灵活）
  const layoutSet = new Set();
  const colorSet = new Set(Object.keys(all.palettes));  // 默认全部预置 palette
  wantedThemes.forEach(t => {
    layoutSet.add(t.layout);
    colorSet.add(t.color);
    quickColorsFor(t).forEach(c => colorSet.add(c));
  });

  // 拼 CSS：:root token + 通用元素 + 各 layout
  const cssParts = [
    '/* 花卷 MD 主题包 · 来自 花卷 (Huājuǎn) · 卷出新花样 */',
    `/* 包含主题: ${wantedThemes.map(t => t.name || t.id).join(', ')} */`,
    '',
    all.rootCss,
    '',
    '/* ===== Markdown 通用元素 ===== */',
    // 通用 .markdown-body 容器样式
    ...extractCommonStyles(all.css),
    '',
    '/* ===== Layout 样式 ===== */',
  ];
  layoutSet.forEach(layoutId => {
    // 优先用 user layout CSS
    if (userLayoutCss[layoutId]) {
      cssParts.push(`/* --- 用户主题 (${layoutId}) --- */`);
      cssParts.push(userLayoutCss[layoutId]);
      cssParts.push('');
      return;
    }
    const blocks = all.layoutCssMap[layoutId];
    if (!blocks) return;
    cssParts.push(`/* --- ${all.layoutLabels[layoutId] || layoutId} (${layoutId}) --- */`);
    cssParts.push(...blocks);
    cssParts.push('');
  });
  const css = cssParts.join('\n');

  // 拼 themes / palettes / 工具函数 JS
  const filteredPalettes = {};
  colorSet.forEach(c => {
    if (userPaletteMap[c]) filteredPalettes[c] = userPaletteMap[c];
    else if (all.palettes[c]) filteredPalettes[c] = all.palettes[c];
  });
  // 用户独立色卡（不绑 layout）一并并入
  Object.assign(filteredPalettes, userPaletteOnly);

  const filteredLabels = {};
  layoutSet.forEach(l => {
    if (all.layoutLabels[l]) filteredLabels[l] = all.layoutLabels[l];
    else {
      const ut = userThemes.find(x => x.id === l);
      if (ut) filteredLabels[l] = ut.name || l;
    }
  });
  const filteredColorLabels = {};
  colorSet.forEach(c => {
    if (all.colorLabels[c]) filteredColorLabels[c] = all.colorLabels[c];
    else if (userPaletteMap[c]) {
      const ut = userThemes.find(x => x.id === c);
      if (ut) filteredColorLabels[c] = ut.name || c;
    }
  });
  Object.entries(userPaletteOnly).forEach(([id, p]) => {
    filteredColorLabels[id] = p.meta?.name || id;
  });

  // 命名空间改写：把所有 --accent 类 token 重命名加前缀，:root 块改成 .markdown-body
  let processedCss = namespaced ? namespaceCss(css) : css;
  if (headingInherit) processedCss = syncH1ToH2H3(processedCss);
  const finalCss = processedCss;

  const js = buildJs(wantedThemes, filteredPalettes, filteredLabels, filteredColorLabels, namespaced);
  const readme = buildReadme(wantedThemes, Object.keys(userPaletteOnly).length, namespaced);

  return {
    'huajuan-themes.css': finalCss,
    'huajuan-themes.js': js,
    'README.md': readme,
  };
}

// 9 个核心 token，全部带前缀并把 :root 改成 .markdown-body
const NAMESPACE_PREFIX = 'hj-';
const NS_TOKENS = ['accent','accent-light','accent-soft','accent-deep','bg','panel','text','text-secondary','border','font-heading','font-body'];
function namespaceCss(css) {
  let out = css;
  // 1. var(--xxx) → var(--hj-xxx)
  NS_TOKENS.forEach(t => {
    const re = new RegExp(`var\\(\\s*--${t}\\b`, 'g');
    out = out.replace(re, `var(--${NAMESPACE_PREFIX}${t}`);
  });
  // 2. :root 块保留为 :root —— 让 token 默认值放在最顶层。
  //    如果改成 .markdown-body，会阻断父级 inline 设的 token 继承到 .markdown-body 自身。
  //    保留 :root 后，父级 inline 优先级（element style > 继承默认）正常工作。
  // 3. :root 内的 token 声明同样加前缀
  NS_TOKENS.forEach(t => {
    const re = new RegExp(`(^|[;{\\s])--${t}\\s*:`, 'g');
    out = out.replace(re, `$1--${NAMESPACE_PREFIX}${t}:`);
  });
  // 4-5. 改写 selector 块（不能用全局替换 — 会把单条规则拆成 group 中的多个项，
  //      第一项命中容器本身导致 inline-block 等容器属性意外应用）
  //      正确做法：扫描每个 ruleset 的 selector 部分，按 `,` 分割成独立 selector，逐个改写
  out = out.replace(/([^{]+)\{/g, (full, selector) => {
    // 跳过 @ 规则等
    if (/^\s*@/.test(selector)) return full;
    const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
    const rewritten = [];
    for (const sel of parts) {
      // 优先匹配后代选择器：.layout-xxx <space|>|+|~> .markdown-body <rest>
      // 把它扩展成两条：自身 .layout-xxx.markdown-body<rest> + 后代 .layout-xxx .markdown-body<rest>
      const descMatch = sel.match(/^\.layout-([a-z0-9-]+)(\s+|\s*>\s*|\s*\+\s*|\s*~\s*)\.markdown-body(\b.*)?$/);
      if (descMatch) {
        const [, id, , rest] = descMatch;
        const tail = rest || '';
        rewritten.push(`.layout-${id}.markdown-body${tail}`);
        rewritten.push(`.layout-${id} .markdown-body${tail}`);
        continue;
      }
      // 后代选择器：.layout-xxx <space> .markdown-body <child>
      // 形如 .layout-xxx .markdown-body h1 / .layout-xxx .markdown-body > p
      const descChildMatch = sel.match(/^\.layout-([a-z0-9-]+)\s+\.markdown-body(\s+|\s*>\s*|\s*\+\s*|\s*~\s*)(.+)$/);
      if (descChildMatch) {
        const [, id, sep, child] = descChildMatch;
        rewritten.push(`.layout-${id}.markdown-body${sep}${child}`);
        rewritten.push(`.layout-${id} .markdown-body${sep}${child}`);
        continue;
      }
      // body.layout-xxx <rest>
      const bodyMatch = sel.match(/^body\.layout-([a-z0-9-]+)(\b.*)?$/);
      if (bodyMatch) {
        const [, id, rest] = bodyMatch;
        const tail = rest || '';
        rewritten.push(`.layout-${id}.markdown-body${tail}`);
        rewritten.push(`body.layout-${id}${tail}`);
        continue;
      }
      rewritten.push(sel);
    }
    return rewritten.join(', ') + ' {';
  });
  // 6. 删掉 markdown-body 自身的 max-width 固定值（720px / 740px 等），改成 100%
  //    简化版：直接全局替换 max-width: NNNpx → max-width: 100%
  //    （主题 CSS 里 max-width 仅用于容器宽度，统一改 100% 不影响其他场景）
  out = out.replace(/max-width\s*:\s*\d+(?:\.\d+)?(?:px|em|rem|ch)/g, 'max-width: 100%');
  // 7. 修复内嵌 SVG data URL：PostCSS 对 url() 内嵌单引号 parse 易炸，
  //    把整段 url(...) 改成用双引号包裹、内部单引号转 URL-encoded（%27），保留装饰
  out = out.replace(/url\(\s*(['"]?)(data:image\/svg\+xml[^)'"]*)\1\s*\)/g, (_full, _q, inner) => {
    const safe = inner.replace(/'/g, '%27').replace(/"/g, '%22');
    return `url("${safe}")`;
  });

  // 8. 末尾追加一段「窄容器兜底」CSS：
  //    保证主题在任意宽度的容器内都不会出现「中文垂直一字列」灾难
  //    （小红书 / 海报 等主题原本设计给 500px+ 宽页面，移植到窄气泡需要这层兜底）
  out += `

/* ===== 容器兜底：防止中文一字列、防止溢出，但不干预主题自身设计 ===== */
.markdown-body {
  display: block;
  width: 100%;
  min-width: 0;
  font-size: 16px;
  word-break: break-word;
  overflow-wrap: anywhere;
  box-sizing: border-box;
}
/* 子元素不溢出（img/table/pre 长内容必须）*/
.markdown-body img,
.markdown-body table,
.markdown-body pre,
.markdown-body code,
.markdown-body iframe {
  max-width: 100%;
}
.markdown-body pre, .markdown-body table { overflow-x: auto; }
`;
  return out;
}

/**
 * 标题层级继承模式：把每个 layout 的 h1 样式同步复制给 h2 / h3
 * 实现方式：扫描每条 ruleset，如果 selector 以「... h1」结尾（且不带其他后续），
 * 复制一份替换成 h2 和 h3。
 *
 * 例如：
 *   .layout-magazine .markdown-body h1 { font-size: 40px; ... }
 * 会额外追加：
 *   .layout-magazine .markdown-body h2 { ...同样的属性... }
 *   .layout-magazine .markdown-body h3 { ...同样的属性... }
 *
 * 已有的 h2 / h3 规则保留（会在 cascade 中和复制的 h1 副本合并）。
 */
function syncH1ToH2H3(css) {
  // 预扫：哪些 layout 的 h3 已经有自己的 ::before / ::after 装饰，
  // 这些主题的 h3 视觉是设计师精心调过的（图钉、序号、花朵等），
  // 再把 h1/h2 胶囊套上去会和原有装饰打架（图标戳进胶囊里、字色被覆盖等）。
  // 这类 layout 跳过 h3 同步，h2 同步照旧。
  const layoutsWithH3Decor = new Set();
  const h3DecorRe = /\.(layout-[a-z0-9-]+)\s+\.markdown-body\s+h3::(before|after)\s*[\{,]/g;
  let mm;
  while ((mm = h3DecorRe.exec(css)) !== null) layoutsWithH3Decor.add(mm[1]);

  // 匹配 ruleset：selector + { declarations }
  // 用栈式扫描避免字符串内 } 的误判
  const out = [];
  let i = 0;
  while (i < css.length) {
    // 跳过到下一个 `{`
    let braceIdx = -1;
    {
      let j = i;
      let inStr = false, strCh = '';
      while (j < css.length) {
        const ch = css[j];
        if (inStr) {
          if (ch === '\\') { j += 2; continue; }
          if (ch === strCh) inStr = false;
        } else {
          if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
          else if (ch === '{') { braceIdx = j; break; }
        }
        j++;
      }
    }
    if (braceIdx < 0) { out.push(css.slice(i)); break; }
    // 找匹配的 `}`
    let endIdx = braceIdx;
    let depth = 1;
    let j = braceIdx + 1;
    let inStr = false, strCh = '';
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (inStr) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === strCh) inStr = false;
      } else {
        if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endIdx = j; break; } }
      }
      j++;
    }
    const selector = css.slice(i, braceIdx);
    const body = css.slice(braceIdx, endIdx + 1);
    out.push(selector + body);

    // 把 h1 装饰复制给 h2/h3，把 h2 装饰追加给 h3，把 h1+p 装饰追加给 h3+p。
    // 让 h3（简报场景的主标题层级）继承全部上层装饰。
    if (!/^\s*@/.test(selector)) {
      const cleanSel = selector.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const parts = cleanSel.split(',').map(s => s.trim()).filter(Boolean);
      const h2Parts = [];  // h1→h2 副本
      const h3FromH1 = []; // h1→h3 副本
      const h3FromH2 = []; // h2→h3 副本
      const h3PlusPFromH1P = []; // h1+p → h3+p 副本
      for (const sel of parts) {
        // 如果该 selector 走的是某个 layout，且该 layout 的 h3 自带 ::before/::after 装饰，
        // 跳过 h3 同步（不影响 h2 同步与 h3+p 段落同步——这两个不会和 h3::before 冲突）
        const layoutMatch = sel.match(/\.(layout-[a-z0-9-]+)\b/);
        const skipH3 = layoutMatch ? layoutsWithH3Decor.has(layoutMatch[1]) : false;
        let m;
        if ((m = sel.match(/^(.+?)\bh1(\b|:[\w:-]+|::[\w-]+)?\s*$/))) {
          h2Parts.push(m[1] + 'h2' + (m[2] || ''));
          if (!skipH3) h3FromH1.push(m[1] + 'h3' + (m[2] || ''));
        } else if ((m = sel.match(/^(.+?)\bh2(\b|:[\w:-]+|::[\w-]+)?\s*$/))) {
          if (!skipH3) h3FromH2.push(m[1] + 'h3' + (m[2] || ''));
        } else if ((m = sel.match(/^(.+?)\bh1\s*\+\s*p\s*$/))) {
          h3PlusPFromH1P.push(m[1] + 'h3 + p');
        }
      }
      const hasAny = h2Parts.length || h3FromH1.length || h3FromH2.length || h3PlusPFromH1P.length;
      if (hasAny) {
        // 剥掉一批"装饰意义不大但容易破坏 h3 视觉"的属性：
        //   font-size  —— h2/h3 用自己字号
        //   letter-spacing —— h1 常配大字距，h3 字数少时会拖太开
        //   -webkit-text-stroke / text-stroke —— h1 的描边空心字效果不该套到 h3
        //   -webkit-text-fill-color —— 同上
        //   text-align —— h1 常居中，h3 一般跟正文左对齐
        // 注意 `\b` 在 `-` 处不匹配，故用 `(?:^|[\s;{])` 锚定开头
        const STRIP_PROPS = /(^|[\s;{])(font-size|letter-spacing|-webkit-text-stroke|text-stroke|-webkit-text-fill-color|text-align)\s*:[^;}]+;?/g;
        let bodyForcedImportant = body.replace(STRIP_PROPS, '$1');
        bodyForcedImportant = bodyForcedImportant.replace(
          /([\w-]+\s*:\s*[^;{}]+?)(?<!!important)(\s*)(;|\})/g,
          (_m, decl, ws, end) => `${decl} !important${ws}${end}`
        );
        if (h2Parts.length)        out.push('\n' + h2Parts.join(', ') + bodyForcedImportant);
        if (h3FromH1.length)       out.push('\n' + h3FromH1.join(', ') + bodyForcedImportant);
        if (h3FromH2.length)       out.push('\n' + h3FromH2.join(', ') + bodyForcedImportant);
        if (h3PlusPFromH1P.length) out.push('\n' + h3PlusPFromH1P.join(', ') + bodyForcedImportant);
      }
    }
    i = endIdx + 1;
  }
  return out.join('');
}

function extractCommonStyles(css) {
  // 抓所有 .markdown-body xxx 通用规则（不带 layout- 前缀的）
  const out = [];
  const lines = css.split('\n');
  let inBlock = false, depth = 0, buf = [];
  for (const line of lines) {
    if (!inBlock) {
      // 简单匹配：以 .markdown-body 开头但不含 .layout-
      if (/^\s*\.markdown-body[^{]*\{/.test(line) && !line.includes('.layout-')) {
        inBlock = true;
        buf = [line];
        depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (depth === 0) { out.push(buf.join('\n')); inBlock = false; }
      } else if (/^\s*\.md-(callout|toc|toc-list|toc-title)/.test(line)) {
        inBlock = true;
        buf = [line];
        depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (depth === 0) { out.push(buf.join('\n')); inBlock = false; }
      }
    } else {
      buf.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth === 0) { out.push(buf.join('\n')); inBlock = false; buf = []; }
    }
  }
  return out;
}

function buildJs(themes, palettes, layoutLabels, colorLabels, namespaced) {
  const px = namespaced ? '--hj-' : '--';
  return `// 花卷 MD 主题包 · 卷出新花样
// Auto-generated. Do not edit by hand.${namespaced ? '\n// 命名空间隔离模式：所有 CSS 变量带 --hj- 前缀，仅作用于 .markdown-body 子树' : ''}

export const themes = ${JSON.stringify(themes, null, 2)};
export const palettes = ${JSON.stringify(palettes, null, 2)};
export const layoutLabels = ${JSON.stringify(layoutLabels, null, 2)};
export const colorLabels = ${JSON.stringify(colorLabels, null, 2)};

const TOKEN_VAR_MAP = {
  'accent': '${px}accent',
  'accentLight': '${px}accent-light',
  'accentSoft': '${px}accent-soft',
  'accentDeep': '${px}accent-deep',
  'bg': '${px}bg',
  'panel': '${px}panel',
  'text': '${px}text',
  'textSecondary': '${px}text-secondary',
  'border': '${px}border',
};

const NAMESPACED = ${namespaced};
// 隔离模式下：默认应用到所有 .markdown-body；非隔离模式：document.body
function resolveScopes(scope) {
  if (scope) return [scope];
  if (NAMESPACED) {
    const list = Array.from(document.querySelectorAll('.markdown-body'));
    return list.length ? list : [document.body];
  }
  return [document.body];
}

function _injectPalette(pal, target) {
  if (!pal?.color) return;
  Object.entries(pal.color).forEach(([k, v]) => {
    const cssVar = TOKEN_VAR_MAP[k];
    if (cssVar) target.style.setProperty(cssVar, v);
  });
}

/**
 * 应用一个完整主题（layout + palette + typography）
 * @param {string} themeId
 * @param {HTMLElement} [scope] 作用域元素；省略时：隔离模式下应用到所有 .markdown-body，非隔离模式应用到 body
 */
export function applyTheme(themeId, scope) {
  const t = themes.find(x => x.id === themeId);
  if (!t) return;
  resolveScopes(scope).forEach(el => {
    Array.from(el.classList).filter(c => c.startsWith('layout-')).forEach(c => el.classList.remove(c));
    el.classList.add('layout-' + t.layout);
    const target = (!NAMESPACED && el === document.body) ? document.documentElement : el;
    _injectPalette(palettes[t.color], target);
  });
}

/** 只换 layout，保留当前 palette / 字体 */
export function applyLayout(layoutId, scope) {
  resolveScopes(scope).forEach(el => {
    Array.from(el.classList).filter(c => c.startsWith('layout-')).forEach(c => el.classList.remove(c));
    el.classList.add('layout-' + layoutId);
  });
}

/** 只换 palette，保留当前 layout */
export function applyPalette(paletteId, scope) {
  const pal = palettes[paletteId];
  if (!pal) return;
  resolveScopes(scope).forEach(el => {
    const target = (!NAMESPACED && el === document.body) ? document.documentElement : el;
    _injectPalette(pal, target);
  });
}

/** 自定义字体；传 null 清掉 */
export function setTypography(tp, scope) {
  resolveScopes(scope).forEach(el => {
    const target = (!NAMESPACED && el === document.body) ? document.documentElement : el;
    if (!tp) {
      target.style.removeProperty(TOKEN_VAR_MAP._fontHeading || '${px}font-heading');
      target.style.removeProperty(TOKEN_VAR_MAP._fontBody || '${px}font-body');
      return;
    }
    if (tp.heading) target.style.setProperty('${px}font-heading', tp.heading);
    if (tp.body) target.style.setProperty('${px}font-body', tp.body);
  });
}

/**
 * 注册一个外部主题（运行时合并预置主题库）
 */
export function registerTheme(theme) {
  if (!theme?.id) return;
  const idx = themes.findIndex(t => t.id === theme.id);
  if (idx >= 0) themes[idx] = theme;
  else themes.push(theme);
}

/**
 * 注册一个外部色卡
 */
export function registerPalette(id, palette) {
  if (!id || !palette) return;
  palettes[id] = palette.color ? palette : { color: palette, meta: { mode: 'light' } };
}

/**
 * 在某个容器里挂载一个简单主题选择器
 * @param {string|HTMLElement} target  选择器或元素
 * @param {object} opts
 * @param {string} opts.defaultTheme  默认主题 id
 * @param {string} opts.persist  'localStorage' 持久化用户选择
 * @param {function} opts.onChange  切换回调
 */
export function mountThemePicker(target, opts = {}) {
  const container = typeof target === 'string' ? document.querySelector(target) : target;
  if (!container) return;
  const persistKey = opts.persist === 'localStorage' ? 'huajuan-theme' : null;
  const stored = persistKey ? localStorage.getItem(persistKey) : null;
  let current = stored || opts.defaultTheme || themes[0]?.id;

  container.innerHTML = '';
  container.style.display = 'grid';
  container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
  container.style.gap = '10px';

  themes.forEach(t => {
    const pal = palettes[t.color];
    const btn = document.createElement('button');
    btn.dataset.themeId = t.id;
    btn.style.cssText = 'border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:10px 8px;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:6px;';
    btn.innerHTML = \`
      <div style="display:flex;height:24px;border-radius:5px;overflow:hidden">
        <span style="flex:1;background:\${pal?.color?.accent || '#ccc'}"></span>
        <span style="flex:1;background:\${pal?.color?.accentLight || '#ddd'}"></span>
        <span style="flex:1;background:\${pal?.color?.bg || '#fff'}"></span>
        <span style="flex:1;background:\${pal?.color?.text || '#333'}"></span>
      </div>
      <div style="font-size:13px;font-weight:600">\${t.name || t.id}</div>
      <div style="font-size:11px;color:#888">\${t.desc || ''}</div>
    \`;
    btn.addEventListener('click', () => {
      current = t.id;
      applyTheme(current);
      if (persistKey) localStorage.setItem(persistKey, current);
      container.querySelectorAll('[data-theme-id]').forEach(b => {
        b.style.borderColor = b.dataset.themeId === current ? '#6366f1' : '#e5e7eb';
        b.style.boxShadow = b.dataset.themeId === current ? '0 0 0 2px rgba(99,102,241,0.2)' : '';
      });
      opts.onChange?.(current, t);
    });
    if (t.id === current) {
      btn.style.borderColor = '#6366f1';
      btn.style.boxShadow = '0 0 0 2px rgba(99,102,241,0.2)';
    }
    container.appendChild(btn);
  });

  // 立即应用
  applyTheme(current);
}
`;
}

function buildReadme(themes, paletteCount = 0, namespaced = true) {
  const themeList = themes.map(t => ({ id: t.id, name: t.name || t.id, desc: t.desc || '' }));
  return `# 花卷 MD 主题包

> 来自 **花卷 (Huājuǎn)** · 卷出新花样

**这是什么**：一套即插即用的 Markdown 视觉主题包。CSS + JS 两个文件，任何已经把 markdown 渲染成 HTML 的网页/应用，套上后立即变成杂志/小红书/简报/品牌风格。

**包含**：${themes.length} 个主题${paletteCount ? ` + ${paletteCount} 套独立色卡` : ''}。所有预置配色都一并打包（${56}+ 套），可与任意 layout 自由组合。

---

## 最快接入（3 步）

\`\`\`html
<link rel="stylesheet" href="./huajuan-themes.css">
<div class="markdown-body" id="content">
  <!-- 这里放你 marked / markdown-it 渲染出的 HTML -->
</div>
<script type="module">
  import { applyTheme } from './huajuan-themes.js';
  applyTheme('${themeList[0]?.id || 'magazine'}');
</script>
\`\`\`

**要点**：
1. 容器必须有 \`class="markdown-body"\`
2. \`applyTheme(themeId)\` 切换主题
3. 不挑 markdown 库（marked / markdown-it / remark / showdown 都行）

---

## 主题清单（${themes.length} 个）

| id | 名称 | 描述 |
|---|---|---|
${themeList.map(t => `| \`${t.id}\` | ${t.name} | ${t.desc} |`).join('\n')}

---

## API 速查

\`\`\`js
import {
  applyTheme,       // 一键切预设主题（layout + 配色 + 字体）
  applyLayout,      // 只切布局，保留当前配色
  applyPalette,     // 只切配色，保留当前布局
  setTypography,    // 只换字体  { heading, body }
  registerTheme,    // 运行时注册外部主题
  registerPalette,  // 运行时注册外部色卡
  mountThemePicker, // 在容器里渲染一个主题选择器
  themes, palettes, layoutLabels, colorLabels,  // 元数据
} from './huajuan-themes.js';

// 1. 一键预设
applyTheme('xhs-study');

// 2. 拆开混搭
applyLayout('magazine');           // 当前色不变，换 layout
applyPalette('xhs-finance');       // 当前 layout 不变，换色

// 3. 字体
setTypography({ heading: 'Songti SC', body: 'Inter' });

// 4. 单消息独立主题（不影响其他容器）
applyTheme('briefing', document.querySelector('#msg-42'));

// 5. 接入方自有主题运行时注入
registerTheme({ id: 'my-brand', layout: 'magazine', color: 'corporate', name: 'My Brand' });
applyTheme('my-brand');
\`\`\`

---

## AI Agent / LLM 接入指南

**让 LLM 知道有哪些主题**（system prompt 里加这段）：

> 你可以为每条 markdown 输出选择一个视觉主题。可选主题清单：
> \`\`\`json
> ${JSON.stringify(themeList, null, 2)}
> \`\`\`
> 输出时把主题 id 通过下面两种协议之一交给前端，**绝对不要直接写在 markdown 正文里**（会被渲染成文字）。

### 协议一：流式 SSE（推荐 ⭐）

服务端流式输出时，**首帧**单独发一个 \`theme\` 事件，后续 \`text\` 帧只发 markdown 内容：

\`\`\`
event: theme
data: {"theme_id":"briefing-sunset"}

event: text
data: {"delta":"# 今日简报\\n\\n..."}
\`\`\`

前端收到 \`theme\` 帧立即 \`applyTheme(id, msgEl)\`，文本到达时已经带着主题渲染，零延迟无闪烁。

\`\`\`js
sse.on('theme', e => {
  const { theme_id } = JSON.parse(e.data);
  applyTheme(theme_id, currentMsgEl);
});
sse.on('text', e => {
  currentMsgEl.innerHTML = renderMarkdown(accumulated += JSON.parse(e.data).delta);
});
\`\`\`

### 协议二：数据库独立字段（历史回放）

历史消息回放时，从数据库 \`messages\` 表的独立字段拿主题 id，跟 markdown 内容彻底解耦：

\`\`\`sql
ALTER TABLE messages ADD COLUMN theme_id TEXT;
\`\`\`

服务端返回时：

\`\`\`json
{ "id": 42, "content": "# 今日简报\\n...", "theme_id": "briefing-sunset" }
\`\`\`

前端渲染：

\`\`\`tsx
messages.map(m => (
  <div ref={el => el && m.theme_id && applyTheme(m.theme_id, el)}
       className="markdown-body"
       dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
))
\`\`\`

### ❌ 不要做的事

- ❌ 不要让 LLM 在 markdown 正文里写自定义标签（如 \`<theme>xxx</theme>\` 或 \`---\\ntheme:xxx\\n---\`）—— 浏览器会把它们**渲染成可见文字**
- ❌ 不要把主题 id 拼进消息文本字段 —— 主题始终走元数据通道（SSE event / 数据库独立字段）

---

## 进阶用法

### 全局主题 + 单消息主题双层

\`\`\`js
// 用户偏好（最高优先）
const userTheme = localStorage.getItem('theme');
if (userTheme) applyTheme(userTheme);  // 不传 scope = 应用到所有 .markdown-body

// 服务端给每条消息的主题（用户没设全局时生效）
messages.forEach(m => {
  if (m.theme_id && !userTheme) applyTheme(m.theme_id, document.querySelector('#msg-' + m.id));
});
\`\`\`

### 持久化 + 主题选择器

\`\`\`js
mountThemePicker('#theme-picker', {
  persist: 'localStorage',
  onChange: (id, theme) => console.log('switched to', id, theme.name),
});
\`\`\`

${namespaced ? `### ⚠️ 命名空间隔离（本包已默认开启）

所有 CSS 变量带 \`--hj-\` 前缀，仅作用于 \`.markdown-body\` 子树。
**不会**冲突接入方原有 token（shadcn 的 \`--accent\`、Tailwind 自定义变量等）。

只要容器加上 \`.markdown-body\` class，外面的 UI 完全不受影响。
` : `### 全局模式

本包应用到 \`:root\`，所有 CSS 变量直接覆盖全局。如果接入方已有同名 token（如 shadcn / Tailwind 的 \`--accent\`），可能冲突。
重新导出时勾选「命名空间隔离」选项可解决。
`}

---

## 数据结构

\`\`\`ts
type Theme = {
  id: string;           // 唯一标识，applyTheme(id) 用这个
  name: string;         // 中文名
  layout: string;       // 关联的 layout id
  color: string;        // 关联的 palette id
  source?: 'preset' | 'huasheng' | 'ai-gen';
  desc?: string;        // 一句话描述
};

type Palette = {
  color: {
    accent: string;          // 主色 #hex
    accentLight: string;     // 主色浅化（背景/底纹）
    accentSoft: string;      // 主色超浅
    accentDeep: string;      // 主色加深（hover/重音）
    bg: string;              // 页面底色
    panel: string;           // 卡片底色
    text: string;            // 正文色
    textSecondary: string;   // 二级文字
    border: string;          // 分割线
  };
  meta: { mode: 'light' | 'dark'; source: string };
};
\`\`\`

---

主题源 · 二次设计 · 在线调试：花卷 MD 主题实验室
`;
}
