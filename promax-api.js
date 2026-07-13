import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data/promax');

function readCsv(file) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(path.join(DATA_DIR, file))
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

let cached = null;
async function loadData() {
  if (cached) return cached;
  const [colors, styles, typography] = await Promise.all([
    readCsv('colors.csv'),
    readCsv('styles.csv'),
    readCsv('typography.csv')
  ]);
  cached = { colors, styles, typography };
  return cached;
}

function score(row, query, fields) {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!q.length) return 1;
  const text = fields.map(f => String(row[f] ?? '')).join(' ').toLowerCase();
  let hits = 0;
  for (const word of q) {
    if (text.includes(word)) hits++;
  }
  return hits;
}

function rank(rows, query, fields) {
  return rows
    .map(row => ({ row, score: score(row, query, fields) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.row);
}

function parseGoogleFonts(cssImport) {
  const match = cssImport.match(/family=([^']+)/);
  if (!match) return [];
  return match[1].split('|').map(chunk => {
    const [name] = chunk.split(':');
    return name.replace(/\+/g, ' ');
  });
}

export function setupPromaxAPI(app) {
  app.get('/api/promax/colors', async (req, res) => {
    try {
      const { colors } = await loadData();
      const q = req.query.q || '';
      const results = rank(colors, q, ['Product Type', 'Notes']);
      res.json({ query: q, count: results.length, results: results.slice(0, 20) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/promax/styles', async (req, res) => {
    try {
      const { styles } = await loadData();
      const q = req.query.q || '';
      const results = rank(styles, q, ['Style Category', 'Keywords', 'Best For', 'AI Prompt Keywords']);
      res.json({ query: q, count: results.length, results: results.slice(0, 20) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/promax/typography', async (req, res) => {
    try {
      const { typography } = await loadData();
      const q = req.query.q || '';
      const results = rank(typography, q, ['Font Pairing Name', 'Mood/Style Keywords', 'Best For', 'Notes', 'Category']);
      res.json({ query: q, count: results.length, results: results.slice(0, 20) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/promax/design', async (req, res) => {
    try {
      const { colors, styles, typography } = await loadData();
      const q = req.query.q || '';
      const [bestColor] = rank(colors, q, ['Product Type', 'Notes']);
      const [bestStyle] = rank(styles, q, ['Style Category', 'Keywords', 'Best For', 'AI Prompt Keywords']);
      const [bestType] = rank(typography, q, ['Font Pairing Name', 'Mood/Style Keywords', 'Best For', 'Notes', 'Category']);

      const design = {
        query: q,
        color: bestColor || null,
        style: bestStyle || null,
        typography: bestType ? { ...bestType, families: parseGoogleFonts(bestType['CSS Import']) } : null,
        tokens: bestColor ? {
          primary: bestColor.Primary,
          accent: bestColor.Accent,
          background: bestColor.Background,
          foreground: bestColor.Foreground,
          card: bestColor.Card,
          muted: bestColor.Muted,
          border: bestColor.Border,
          secondary: bestColor.Secondary
        } : null
      };
      res.json(design);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
