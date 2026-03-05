#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULT_EXTS = new Set(['.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.yml', '.yaml']);

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function estimateTokens(text) {
  // Fast heuristic: ~4 chars/token for mixed English/code.
  return Math.ceil((text || '').length / 4);
}

function fileStats(file) {
  const content = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length;
  const tokens = estimateTokens(content);
  return { file, bytes, lines, tokens };
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function aggregateByFolder(stats, root) {
  const buckets = new Map();
  for (const s of stats) {
    const rel = path.relative(root, s.file);
    const folder = rel.includes(path.sep) ? rel.split(path.sep)[0] : '.';
    const cur = buckets.get(folder) || { folder, files: 0, bytes: 0, tokens: 0 };
    cur.files += 1;
    cur.bytes += s.bytes;
    cur.tokens += s.tokens;
    buckets.set(folder, cur);
  }
  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens);
}

function parseArgs(argv) {
  const args = { root: process.cwd(), top: 20, out: '', includeAll: false, html: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--html') args.html = path.resolve(argv[++i]);
    else if (a === '--all') args.includeAll = true;
  }
  return args;
}

function renderHtml(report) {
  const rows = report.topFiles.map((f, i) => `<tr><td>${i + 1}</td><td>${f.file}</td><td>${f.tokens.toLocaleString()}</td><td>${f.lines}</td><td>${f.bytes.toLocaleString()}</td></tr>`).join('');
  const folders = report.byFolder.map(f => `<tr><td>${f.folder}</td><td>${f.files}</td><td>${f.tokens.toLocaleString()}</td><td>${f.bytes.toLocaleString()}</td></tr>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Token Audit</title>
<style>body{font-family:Inter,system-ui,sans-serif;padding:24px;max-width:1100px;margin:0 auto}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left}th{background:#fafafa}.kpi{display:flex;gap:16px}.card{border:1px solid #ddd;padding:12px 16px;border-radius:8px}</style></head>
<body>
<h1>Token Audit Report</h1>
<div class="kpi">
  <div class="card"><strong>Total Files</strong><br/>${report.summary.files.toLocaleString()}</div>
  <div class="card"><strong>Total Tokens (est.)</strong><br/>${report.summary.tokens.toLocaleString()}</div>
  <div class="card"><strong>Total Size</strong><br/>${report.summary.bytes.toLocaleString()} B</div>
</div>
<h2>Top Files</h2>
<table><tr><th>#</th><th>File</th><th>Tokens</th><th>Lines</th><th>Bytes</th></tr>${rows}</table>
<h2>By Folder</h2>
<table><tr><th>Folder</th><th>Files</th><th>Tokens</th><th>Bytes</th></tr>${folders}</table>
</body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const files = walk(args.root).filter(f => args.includeAll || DEFAULT_EXTS.has(path.extname(f).toLowerCase()));
  const stats = files.map(fileStats).sort((a, b) => b.tokens - a.tokens);
  const summary = {
    root: args.root,
    files: stats.length,
    tokens: stats.reduce((n, s) => n + s.tokens, 0),
    bytes: stats.reduce((n, s) => n + s.bytes, 0),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    topFiles: stats.slice(0, args.top).map(s => ({ ...s, file: path.relative(args.root, s.file) })),
    byFolder: aggregateByFolder(stats, args.root),
    notes: [
      'Token estimate uses a simple 4 chars/token heuristic.',
      'Use this for relative comparison and pruning decisions, not billing exactness.'
    ]
  };

  console.log(`Scanned ${summary.files} files in ${args.root}`);
  console.log(`Estimated tokens: ${summary.tokens.toLocaleString()} | Size: ${formatBytes(summary.bytes)}`);
  console.log('Top token-heavy files:');
  report.topFiles.slice(0, 10).forEach((f, i) => {
    console.log(`${String(i + 1).padStart(2, '0')}. ${f.tokens.toLocaleString()}  ${f.file}`);
  });

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report: ${args.out}`);
  }

  if (args.html) {
    fs.mkdirSync(path.dirname(args.html), { recursive: true });
    fs.writeFileSync(args.html, renderHtml(report));
    console.log(`Wrote HTML report: ${args.html}`);
  }
}

main();
