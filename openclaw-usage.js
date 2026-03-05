#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function run(cmd) {
  return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseStatus(text) {
  const lines = text.split('\n');
  const out = {
    capturedAt: new Date().toISOString(),
    overview: {},
    sessions: [],
    securitySummary: '',
    raw: text
  };

  const sec = text.match(/Security audit\nSummary:\s*(.+)/);
  if (sec) out.securitySummary = sec[1].trim();

  const model = text.match(/\|\s*Sessions\s*\|\s*\d+ active\s*·\s*default\s*([^·]+)·/);
  if (model) out.overview.defaultModel = model[1].trim();

  const sessionStart = lines.findIndex(l => l.trim() === 'Sessions');
  if (sessionStart !== -1) {
    for (let i = sessionStart + 3; i < lines.length; i++) {
      const l = lines[i];
      if (!l.startsWith('│')) continue;
      if (l.includes('└') || l.includes('FAQ:')) break;
      const cols = l.split('│').map(s => s.trim()).filter(Boolean);
      if (cols.length < 5) continue;
      const [key, kind, age, modelName, tokens] = cols;
      if (key === 'Key') continue;
      out.sessions.push({ key, kind, age, model: modelName, tokens });
    }
  }

  return out;
}

function tokenFromCell(cell) {
  const m = cell.match(/([\d.]+)k\/(\d+)k/i);
  if (!m) return null;
  return { usedK: Number(m[1]), ctxK: Number(m[2]) };
}

function summarize(parsed) {
  let usedK = 0;
  let known = 0;
  const byModel = {};

  for (const s of parsed.sessions) {
    const t = tokenFromCell(s.tokens);
    if (!t) continue;
    known += 1;
    usedK += t.usedK;
    byModel[s.model] = (byModel[s.model] || 0) + t.usedK;
  }

  return {
    capturedAt: parsed.capturedAt,
    securitySummary: parsed.securitySummary,
    sessionCount: parsed.sessions.length,
    knownTokenSessions: known,
    estimatedUsedTokens: Math.round(usedK * 1000),
    byModelEstimatedTokens: byModel,
  };
}

function renderHtml(history) {
  const rows = history.map((h, i) => `<tr><td>${i + 1}</td><td>${h.capturedAt}</td><td>${h.sessionCount}</td><td>${h.estimatedUsedTokens.toLocaleString()}</td><td>${h.securitySummary || '-'}</td></tr>`).join('');
  const latest = history[history.length - 1];
  const modelRows = latest ? Object.entries(latest.byModelEstimatedTokens || {}).sort((a,b)=>b[1]-a[1]).map(([m,v]) => `<tr><td>${m}</td><td>${Math.round(v*1000).toLocaleString()}</td></tr>`).join('') : '';

  return `<!doctype html><html><head><meta charset="utf-8"/><title>OpenClaw Usage</title>
  <style>body{font-family:Inter,system-ui,sans-serif;padding:24px;max-width:1100px;margin:0 auto}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left}th{background:#fafafa}</style></head><body>
  <h1>OpenClaw Usage Trend</h1>
  <p>Snapshots: ${history.length}</p>
  <h2>Latest Model Breakdown</h2>
  <table><tr><th>Model</th><th>Estimated Tokens</th></tr>${modelRows}</table>
  <h2>History</h2>
  <table><tr><th>#</th><th>Captured</th><th>Sessions</th><th>Estimated Tokens</th><th>Security</th></tr>${rows}</table>
  </body></html>`;
}

function cmdCapture(root) {
  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const raw = run('openclaw status');
  const parsed = parseStatus(raw);
  const summary = summarize(parsed);

  const snapshotsPath = path.join(reportsDir, 'usage-history.json');
  let history = [];
  if (fs.existsSync(snapshotsPath)) {
    history = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'));
  }
  history.push(summary);
  history = history.slice(-50);

  fs.writeFileSync(path.join(reportsDir, 'openclaw-status.txt'), raw);
  fs.writeFileSync(path.join(reportsDir, 'usage-latest.json'), JSON.stringify({ parsed, summary }, null, 2));
  fs.writeFileSync(snapshotsPath, JSON.stringify(history, null, 2));
  fs.writeFileSync(path.join(reportsDir, 'usage-dashboard.html'), renderHtml(history));

  console.log('Captured OpenClaw usage snapshot.');
  console.log(`Sessions: ${summary.sessionCount}, estimated tokens: ${summary.estimatedUsedTokens.toLocaleString()}`);
}

function main() {
  const root = process.cwd();
  const cmd = process.argv[2] || 'capture';
  if (cmd === 'capture') return cmdCapture(root);
  console.error('Usage: node openclaw-usage.js capture');
  process.exit(1);
}

main();
