#!/usr/bin/env node
/**
 * Standalone Sunlit Editorial Studio HTML preview generator for BankImportManifest JSON.
 * Zero external dependencies. Uses the app's public/fonts/*.woff2 when run inside the repo
 * (falls back to system fonts elsewhere).
 *
 * Usage:
 *   node scripts/preview_manifest.mjs <manifest.json> [output.html] [--embed-fonts]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifestObject } from './validate_manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_FONTS_DIR = path.resolve(__dirname, '../fonts');
const REPO_FONTS_DIR = path.resolve(__dirname, '../../../public/fonts');
const FONTS_DIR = fs.existsSync(BUNDLED_FONTS_DIR) ? BUNDLED_FONTS_DIR : REPO_FONTS_DIR;

const args = process.argv.slice(2);
const embedFonts = args.includes('--embed-fonts');
const positional = args.filter((a) => !a.startsWith('--'));
const inputPath = positional[0];
const outputPath = positional[1] || inputPath?.replace(/\.json$/i, '.preview.html');

if (!inputPath) {
  console.error('Usage: node scripts/preview_manifest.mjs <manifest.json> [output.html] [--embed-fonts]');
  process.exit(2);
}

const absIn = path.resolve(inputPath);
const absOut = path.resolve(outputPath);
const manifest = JSON.parse(fs.readFileSync(absIn, 'utf8'));
const validation = validateManifestObject(manifest);

const FONT_SPECS = [
  ['AnthropicSerifDisplay', 'AnthropicSerif-Display-Regular-Static.woff2', 400, 'normal'],
  ['AnthropicSerifDisplay', 'AnthropicSerif-Display-Bold-Static.woff2', 700, 'normal'],
  ['AnthropicSerifText', 'AnthropicSerif-Text-Regular-Static.woff2', 400, 'normal'],
  ['AnthropicSerifText', 'AnthropicSerif-Text-RegularItalic-Static.woff2', 400, 'italic'],
  ['AnthropicSerifText', 'AnthropicSerif-Text-Medium-Static.woff2', 500, 'normal'],
  ['AnthropicSansDisplay', 'AnthropicSans-Display-Semibold-Static.woff2', 600, 'normal'],
  ['AnthropicSansText', 'AnthropicSans-Text-Regular-Static.woff2', 400, 'normal'],
  ['AnthropicSansText', 'AnthropicSans-Text-Medium-Static.woff2', 500, 'normal'],
  ['AnthropicSansText', 'AnthropicSans-Text-Semibold-Static.woff2', 600, 'normal'],
  ['AnthropicMono', 'AnthropicMono-Web.woff2', 400, 'normal'],
];

function buildFontCss() {
  const relFontDir = path.relative(path.dirname(absOut), FONTS_DIR).split(path.sep).join('/');
  return FONT_SPECS.map(([family, file, weight, style]) => {
    const absFont = path.join(FONTS_DIR, file);
    if (!fs.existsSync(absFont)) return '';
    let srcUrl;
    if (embedFonts) {
      const b64 = fs.readFileSync(absFont).toString('base64');
      srcUrl = `data:font/woff2;base64,${b64}`;
    } else {
      srcUrl = `${relFontDir ? relFontDir + '/' : ''}${encodeURIComponent(file)}`;
    }
    return `@font-face { font-family: '${family}'; src: url('${srcUrl}') format('woff2'); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`;
  })
    .filter(Boolean)
    .join('\n');
}

// Safely escape JSON for embedding in <script>
const safeManifestJson = JSON.stringify(manifest).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const safeValidationJson = JSON.stringify(validation).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Selective Lab Preview — ${String(manifest.batchLabel || 'Manifest').replace(/[<>&"]/g, '')}</title>
<style>
${buildFontCss()}

:root {
  --font-serif-display: 'AnthropicSerifDisplay', Georgia, serif;
  --font-serif-text: 'AnthropicSerifText', Georgia, Cambria, serif;
  --font-sans-display: 'AnthropicSansDisplay', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-sans-text: 'AnthropicSansText', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono: 'AnthropicMono', ui-monospace, SFMono-Regular, Menlo, monospace;

  --bg-shell: #F3EFE8;
  --bg-canvas: #FAF8F5;
  --bg-elevated: #FFFFFF;
  --bg-hover: #EAE4DA;
  --text-primary: #113C36;
  --text-secondary: #4A5955;
  --text-muted: #78756E;
  --border-hairline: #E5DFD5;
  --border-strong: #CFC6B9;
  --accent-primary: #113C36;
  --accent-soft: #E5F0EA;
  --coral: #F29A63;
  --coral-soft: #FDE8D7;
  --success: #1D6346;
  --success-bg: #E5F3EC;
  --warn: #A35116;
  --warn-bg: #FDF0E2;
  --error: #B42318;
  --error-bg: #FDECEB;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg-shell);
  color: var(--text-primary);
  font-family: var(--font-sans-text);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-hairline);
  padding: 12px 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand h1 {
  margin: 0;
  font-family: var(--font-serif-display);
  font-size: 18px;
  font-weight: 700;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--bg-shell);
  color: var(--text-secondary);
}
.pill.pass { background: var(--success-bg); color: var(--success); }
.pill.fail { background: var(--error-bg); color: var(--error); }
.pill.sec { background: var(--accent-soft); color: var(--accent-primary); }
.mono { font-family: var(--font-mono); font-size: 12px; }

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.btn {
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.btn:hover { background: var(--bg-hover); }
.btn.primary { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); }
.btn.primary:hover { background: #0B2B26; }
.btn.active { background: var(--accent-soft); border-color: var(--accent-primary); }

.nav-strip {
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border-hairline);
  padding: 10px 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.q-chip {
  border: 1px solid var(--border-hairline);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.q-chip.current {
  background: var(--accent-primary);
  color: #fff;
  border-color: var(--accent-primary);
}

main {
  max-width: 1280px;
  margin: 20px auto;
  padding: 0 20px 48px;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
main.single-pane {
  grid-template-columns: minmax(0, 820px);
  justify-content: center;
}
@media (max-width: 900px) {
  main { grid-template-columns: 1fr; }
}

.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-hairline);
  border-radius: 14px;
  padding: 20px 22px;
}
.stimulus-pane {
  position: sticky;
  top: 76px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
}
.reading-prose {
  font-family: var(--font-serif-text);
  font-size: 16.5px;
  line-height: 1.72;
  white-space: pre-wrap;
}
.poem-prose {
  font-family: var(--font-serif-text);
  font-size: 16.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  padding-left: 14px;
  border-left: 3px solid var(--coral);
}
.gap-pill {
  display: inline-block;
  padding: 1px 8px;
  margin: 0 2px;
  border-radius: 6px;
  background: var(--coral-soft);
  border: 1px solid var(--coral);
  color: var(--text-primary);
  font-family: var(--font-sans-text);
  font-size: 12px;
  font-weight: 600;
}
.extract-box {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
}
.extract-box .extract-head {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
}
.decoy-tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warn-bg);
  color: var(--warn);
}
.figure-card {
  margin: 12px 0;
  padding: 14px;
  border: 1px solid var(--border-hairline);
  border-radius: 12px;
  background: #fff;
  text-align: center;
}
.figure-card svg {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}
.figure-caption {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

table.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
table.data-table th {
  text-align: left;
  padding: 8px 10px;
  background: var(--bg-shell);
  border-bottom: 1px solid var(--border-strong);
  font-weight: 600;
}
table.data-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-hairline);
}

.part-block {
  border-top: 1px solid var(--border-hairline);
  padding-top: 16px;
  margin-top: 16px;
}
.part-block:first-child { border-top: none; padding-top: 0; margin-top: 0; }
.part-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--text-muted);
}
.prompt {
  font-size: 15.5px;
  font-weight: 500;
  margin: 6px 0 12px;
}
.stem-box {
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: 10px;
  padding: 12px 14px;
  margin: 8px 0 14px;
  font-size: 14.5px;
  color: var(--text-primary);
}
.stem-heading {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.fmt-blocks p { margin: 0 0 10px; }
.fmt-blocks p:last-child { margin-bottom: 0; }
.fmt-blocks ul, .fmt-blocks ol { margin: 0 0 10px; padding-left: 20px; }
.fmt-blocks li { margin-bottom: 5px; }
.fmt-blocks li:last-child { margin-bottom: 0; }

.options-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.options-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-hairline);
  background: var(--bg-canvas);
  color: var(--text-primary);
  cursor: pointer;
  font-family: inherit;
  font-size: 14.5px;
}
.option-btn:hover { background: var(--bg-hover); }
.option-btn.tile {
  flex-direction: column;
  align-items: stretch;
  padding: 10px;
}
.option-stage {
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--border-hairline);
  padding: 6px;
  margin-top: 6px;
}
.option-stage svg {
  max-height: 100%;
  max-width: 100%;
  width: auto;
  height: 100%;
}
.option-btn.selected { border-color: var(--accent-primary); background: var(--accent-soft); }
.option-btn.correct { border-color: var(--success); background: var(--success-bg); }
.option-btn.wrong { border-color: var(--error); background: var(--error-bg); }
.opt-letter { font-weight: 700; min-width: 18px; }

.pool-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.pool-btn {
  min-width: 38px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-canvas);
  font-weight: 700;
  cursor: pointer;
}
.pool-btn.selected { background: var(--accent-soft); border-color: var(--accent-primary); }
.pool-btn.correct { background: var(--success-bg); border-color: var(--success); color: var(--success); }
.pool-btn.wrong { background: var(--error-bg); border-color: var(--error); color: var(--error); }

.solution-box {
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bg-canvas);
  border-left: 3px solid var(--accent-primary);
  font-size: 14px;
}
.solution-box h4 {
  margin: 0 0 8px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.worked-text { margin: 0 0 10px; }
.rationales { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: var(--text-secondary); }
.rationales li { margin-bottom: 4px; }
.evidence-quote {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--coral-soft);
  font-size: 12.5px;
}
.writing-spec {
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 12px;
}
.writing-spec ul { margin: 8px 0 0; padding-left: 20px; }
.opening-line {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--coral-soft);
  border-radius: 8px;
  font-family: var(--font-serif-text);
  font-style: italic;
}
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Selective Lab Preview</h1>
    <span class="pill mono" id="batch-label"></span>
    <span class="pill" id="val-badge"></span>
  </div>
  <div class="toolbar">
    <button class="btn" id="btn-prev">← Prev</button>
    <button class="btn" id="btn-next">Next →</button>
    <button class="btn primary" id="btn-toggle-solutions">Show Year 6 Solutions</button>
  </div>
</header>
<div class="nav-strip" id="nav-strip"></div>
<main id="stage"></main>

<script>
const MANIFEST = ${safeManifestJson};
const VALIDATION = ${safeValidationJson};
const STIM_MAP = new Map((MANIFEST.stimuli || []).map(s => [s.stimulusId, s]));

let currentIndex = 0;
let showSolutions = false;
const selectedByPart = {};

document.getElementById('batch-label').textContent = MANIFEST.batchLabel || 'manifest';
const valBadge = document.getElementById('val-badge');
valBadge.className = 'pill ' + (VALIDATION.valid ? 'pass' : 'fail');
valBadge.textContent = VALIDATION.valid
  ? 'Valid (' + VALIDATION.stats.questionsCount + ' Qs · ' + VALIDATION.stats.partsCount + ' parts' + (VALIDATION.warnings.length ? ' · ' + VALIDATION.warnings.length + ' warn' : '') + ')'
  : 'Invalid (' + VALIDATION.errors.length + ' errors)';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderVisual(v, isTile) {
  if (!v || v.visualType === 'none') return '';
  if (v.visualType === 'inline_svg' && v.svgMarkup) {
    if (isTile) return '<div class="option-stage">' + v.svgMarkup + '</div>';
    return '<figure class="figure-card">' + v.svgMarkup + (v.caption ? '<figcaption class="figure-caption">' + esc(v.caption) + '</figcaption>' : '') + '</figure>';
  }
  if (v.visualType === 'structured_table' && v.tableData) {
    const ths = v.tableData.headers.map(h => '<th>' + esc(h) + '</th>').join('');
    const trs = v.tableData.rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('');
    const cap = v.tableData.caption || v.caption;
    return '<figure class="figure-card" style="text-align:left">' + (cap ? '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">' + esc(cap) + '</div>' : '') + '<table class="data-table"><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table></figure>';
  }
  if (v.visualType === 'image_asset' && v.imageUrl) {
    return '<figure class="figure-card"><img src="' + esc(v.imageUrl) + '" alt="' + esc(v.altText) + '" style="max-height:288px;max-width:100%" /></figure>';
  }
  return '';
}

function renderPassage(text) {
  return esc(text).replace(/\\{\\{(gap:\\d+)\\}\\}/g, (_, g) => '<span class="gap-pill">' + g.toUpperCase() + '</span>');
}

function renderFormattedText(text, isBoxed) {
  const norm = String(text ?? '').replace(/\\r\\n/g, '\\n').trim();
  if (!norm) return '';
  const chunks = norm.split(/\\n\\s*\\n/);
  const html = [];
  let firstChunk = true;
  for (const chunk of chunks) {
    const lines = chunk.split('\\n').map(l => l.replace(/[ \\t]+$/g, '')).filter(l => l.trim());
    let i = 0;
    if (isBoxed && firstChunk && /^Boxed rules(?:\\s*[—–-]\\s*[^:]+)?:\\s*$/i.test(lines[0] || '')) {
      html.push('<div class="stem-heading">' + esc(lines[0].trim()) + '</div>');
      i = 1;
    }
    firstChunk = false;
    while (i < lines.length) {
      if (/^\\s*(?:•\\s*|[-*]\\s+)/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\\s*(?:•\\s*|[-*]\\s+)/.test(lines[i])) {
          items.push('<li>' + esc(lines[i].replace(/^\\s*(?:•\\s*|[-*]\\s+)/, '').trim()) + '</li>');
          i++;
        }
        html.push('<ul>' + items.join('') + '</ul>');
      } else if (/^\\s*\\d+[.)]\\s+/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {
          items.push('<li>' + esc(lines[i].replace(/^\\s*\\d+[.)]\\s+/, '').trim()) + '</li>');
          i++;
        }
        html.push('<ol>' + items.join('') + '</ol>');
      } else {
        const pLines = [];
        while (i < lines.length && !/^\\s*(?:•\\s*|[-*]\\s+|\\d+[.)]\\s+)/.test(lines[i])) {
          const ln = lines[i].trimStart();
          const spk = ln.match(/^([A-Z][A-Za-z'’ -]{1,24}:)\\s+(["“‘'].+)$/);
          pLines.push(spk ? '<strong>' + esc(spk[1]) + '</strong> ' + esc(spk[2]) : esc(ln));
          i++;
        }
        const style = pLines.some(l => / {2,}/.test(l)) || pLines.length > 1 ? ' style="white-space:pre-wrap"' : '';
        html.push('<p' + style + '>' + pLines.join('<br/>') + '</p>');
      }
    }
  }
  return '<div class="fmt-blocks">' + html.join('') + '</div>';
}

function renderNav() {
  const strip = document.getElementById('nav-strip');
  strip.innerHTML = MANIFEST.questions.map((q, idx) => {
    const active = idx === currentIndex ? ' current' : '';
    return '<button class="q-chip' + active + '" data-idx="' + idx + '">Q' + (idx + 1) + ' · ' + esc(q.section) + ' (' + esc(q.formatType.replace(/^[A-Z]+_/, '')) + ')</button>';
  }).join('');
  strip.querySelectorAll('.q-chip').forEach(btn => {
    btn.addEventListener('click', () => { currentIndex = Number(btn.dataset.idx); render(); });
  });
}

function render() {
  renderNav();
  const q = MANIFEST.questions[currentIndex];
  const stim = q.stimulusId ? STIM_MAP.get(q.stimulusId) : null;
  const stage = document.getElementById('stage');

  const hasLeftPane = Boolean(stim || (q.visual && q.visual.visualType !== 'none'));
  stage.className = hasLeftPane ? '' : 'single-pane';

  let leftHtml = '';
  if (hasLeftPane) {
    leftHtml += '<section class="card stimulus-pane">';
    if (stim) {
      leftHtml += '<div class="part-meta"><span class="pill sec">' + esc(stim.section) + ' · ' + esc(stim.genreOrTextType) + '</span><span class="mono">' + esc(stim.stimulusId) + '</span></div>';
      if (stim.title) leftHtml += '<h2 style="font-family:var(--font-serif-display);margin:6px 0 10px;font-size:22px">' + esc(stim.title) + '</h2>';
      if (stim.preamble) leftHtml += '<p style="font-size:13.5px;color:var(--text-secondary);font-style:italic;margin:0 0 12px">' + esc(stim.preamble) + '</p>';
      if (stim.visual) leftHtml += renderVisual(stim.visual, false);
      if (stim.mainTextMarkdown) {
        const cls = stim.genreOrTextType === 'poem' ? 'poem-prose' : 'reading-prose';
        leftHtml += '<div class="' + cls + '">' + renderPassage(stim.mainTextMarkdown) + '</div>';
      }
      if (Array.isArray(stim.extracts) && stim.extracts.length) {
        leftHtml += stim.extracts.map(ex => {
          const decoyBadge = (showSolutions && ex.isDecoy) ? '<span class="decoy-tag">Unused Decoy</span>' : '';
          return '<div class="extract-box"><div class="extract-head"><span>Extract ' + esc(ex.label) + (ex.title ? ' — ' + esc(ex.title) : '') + '</span>' + decoyBadge + '</div><div class="reading-prose" style="font-size:15px">' + esc(ex.bodyMarkdown) + '</div></div>';
        }).join('');
      }
    }
    if (q.visual && q.visual.visualType !== 'none') {
      leftHtml += '<div class="part-meta"><span class="pill sec">' + esc(q.section) + ' · Diagram</span><span class="mono">' + esc(q.questionId) + '</span></div>';
      leftHtml += renderVisual(q.visual, false);
    }
    leftHtml += '</section>';
  }

  let rightHtml = '<section class="card">';
  rightHtml += '<div class="part-meta"><span class="pill sec">' + esc(q.section) + ' · ' + esc(q.formatType) + '</span><span class="mono">' + esc(q.questionId) + '</span><span class="pill">' + esc(q.qcStatus || MANIFEST.defaultQcStatus) + '</span></div>';
  if (q.stemPrefix) rightHtml += '<div class="stem-box">' + renderFormattedText(q.stemPrefix, true) + '</div>';

  if (q.writingSpec) {
    const ws = q.writingSpec;
    rightHtml += '<div class="writing-spec">';
    rightHtml += '<div><strong>Genre:</strong> ' + esc(ws.genre) + ' · <strong>Audience:</strong> ' + esc(ws.audience) + '</div>';
    rightHtml += '<div style="margin-top:4px"><strong>Purpose:</strong> ' + esc(ws.purpose) + '</div>';
    rightHtml += '<div style="margin-top:4px;font-size:12.5px;color:var(--text-muted)">Recommended: ' + ws.recommendedWordRange[0] + '–' + ws.recommendedWordRange[1] + ' words · ' + Math.round(ws.timeLimitSec / 60) + ' minutes</div>';
    if (ws.mandatoryOpeningLine) rightHtml += '<div class="opening-line">Mandatory opening: "' + esc(ws.mandatoryOpeningLine) + '"</div>';
    if (Array.isArray(ws.bulletSuggestions) && ws.bulletSuggestions.length) {
      rightHtml += '<ul>' + ws.bulletSuggestions.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>';
    }
    rightHtml += '</div>';
  }

  rightHtml += q.parts.map((p, idx) => {
    const sel = selectedByPart[p.partId];
    const hasVisualOpts = (p.options || []).some(o => o.visual && o.visual.visualType !== 'none');
    const useGrid = hasVisualOpts && (p.options || []).every(o => !o.text || o.text.trim().length <= 48);

    let optsHtml = '';
    if (p.options && p.options.length > 0) {
      optsHtml = '<div class="' + (useGrid ? 'options-grid' : 'options-list') + '">' + p.options.map(o => {
        let cls = 'option-btn' + (useGrid ? ' tile' : '');
        if (showSolutions && o.key === p.correctAnswerKey) cls += ' correct';
        else if (sel === o.key && showSolutions && o.key !== p.correctAnswerKey) cls += ' wrong';
        else if (sel === o.key) cls += ' selected';
        const head = '<div><span class="opt-letter">' + esc(o.key) + '</span>' + (o.text ? ' ' + esc(o.text) : '') + '</div>';
        const vis = o.visual ? renderVisual(o.visual, useGrid) : '';
        return '<button class="' + cls + '" data-part="' + esc(p.partId) + '" data-key="' + esc(o.key) + '">' + head + vis + '</button>';
      }).join('') + '</div>';
    } else if (q.sharedPoolConfig) {
      optsHtml = '<div class="pool-pills">' + q.sharedPoolConfig.poolKeys.map(k => {
        let cls = 'pool-btn';
        if (showSolutions && k === p.correctAnswerKey) cls += ' correct';
        else if (sel === k && showSolutions && k !== p.correctAnswerKey) cls += ' wrong';
        else if (sel === k) cls += ' selected';
        return '<button class="' + cls + '" data-part="' + esc(p.partId) + '" data-key="' + esc(k) + '">' + esc(k) + '</button>';
      }).join('') + '</div>';
    }

    let solHtml = '';
    if (showSolutions) {
      const drEntries = Object.entries(p.distractorRationales || {});
      const drHtml = drEntries.length
        ? '<ul class="rationales">' + drEntries.map(([k, v]) => '<li><strong>' + esc(k) + ':</strong> ' + esc(v) + '</li>').join('') + '</ul>'
        : '';
      const evHtml = Array.isArray(p.evidenceRefs) && p.evidenceRefs.length
        ? p.evidenceRefs.map(r => '<div class="evidence-quote"><strong>Evidence (' + esc(r.targetKind) + (r.extractLabel ? ' ' + esc(r.extractLabel) : '') + ' [' + r.startOffset + '..' + r.endOffset + ']):</strong> "' + esc(r.quote) + '"</div>').join('')
        : '';
      solHtml = '<div class="solution-box"><h4>' + (p.correctAnswerKey ? 'Answer: ' + esc(p.correctAnswerKey) + ' · ' : '') + 'Year 6 Worked Solution</h4><div class="worked-text">' + renderFormattedText(p.workedExplanation, false) + '</div>' + drHtml + evHtml + '</div>';
    }

    return '<div class="part-block">'
      + '<div class="part-meta">'
      + (p.slotRef ? '<span class="pill">' + esc(p.slotRef) + '</span>' : '<span class="pill">Part ' + (idx + 1) + '</span>')
      + '<span class="mono">' + esc(p.skillId) + '</span>'
      + '<span>Diff ' + esc(p.difficultyInitial) + ' · ' + esc(p.targetTimeSec) + 's · ' + esc(p.cognitiveDemand) + '</span>'
      + '</div>'
      + '<div class="prompt">' + renderFormattedText(p.promptText, false) + '</div>'
      + optsHtml
      + solHtml
      + '</div>';
  }).join('');

  rightHtml += '</section>';
  stage.innerHTML = leftHtml + rightHtml;

  stage.querySelectorAll('[data-part][data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedByPart[btn.dataset.part] = btn.dataset.key;
      render();
    });
  });
}

document.getElementById('btn-prev').addEventListener('click', () => {
  currentIndex = (currentIndex - 1 + MANIFEST.questions.length) % MANIFEST.questions.length;
  render();
});
document.getElementById('btn-next').addEventListener('click', () => {
  currentIndex = (currentIndex + 1) % MANIFEST.questions.length;
  render();
});
document.getElementById('btn-toggle-solutions').addEventListener('click', (e) => {
  showSolutions = !showSolutions;
  e.target.textContent = showSolutions ? 'Hide Year 6 Solutions' : 'Show Year 6 Solutions';
  render();
});

render();
</script>
</body>
</html>
`;

fs.writeFileSync(absOut, html, 'utf8');
console.log(`Preview written to ${absOut} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
