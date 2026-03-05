#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function run(cmd) {
  return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseStatus(text) {
  const out = { capturedAt: new Date().toISOString(), securitySummary: '', raw: text };
  const sec = text.match(/Security audit\nSummary:\s*(.+)/);
  if (sec) out.securitySummary = sec[1].trim();
  return out;
}

function parseSecurityCounts(summary) {
  const s = String(summary || '');
  const pick = (k) => Number((s.match(new RegExp(`(\\d+)\\s+${k}`, 'i')) || [])[1] || 0);
  return { critical: pick('critical'), warn: pick('warn'), info: pick('info') };
}

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, visitor);
    else if (e.isFile()) visitor(full);
  }
}

function estimateTokensFromChars(chars) {
  return Math.round(chars / 4);
}

function buildContextProfiler(root) {
  const files = new Set();
  const workspaceRoot = path.resolve(root, '..', '..');

  // 1) root: *.md
  for (const name of fs.readdirSync(root)) {
    if (name.toLowerCase().endsWith('.md')) files.add(path.join(root, name));
  }

  // 2) memory/*.md
  const memoryDir = path.join(root, 'memory');
  if (fs.existsSync(memoryDir)) {
    for (const name of fs.readdirSync(memoryDir)) {
      if (name.toLowerCase().endsWith('.md')) files.add(path.join(memoryDir, name));
    }
  }

  // 3) agents/**/(SOUL|USER|MEMORY|AGENTS|TOOLS).md
  const agentFiles = new Set(['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md', 'TOOLS.md']);
  const agentsDir = path.join(workspaceRoot, 'agents');
  walk(agentsDir, (full) => {
    if (agentFiles.has(path.basename(full))) files.add(full);
  });

  const rows = [];
  let totalBytes = 0;
  let totalLines = 0;
  let totalEstimatedTokens = 0;

  for (const full of files) {
    try {
      const stat = fs.statSync(full);
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
      const bytes = stat.size;
      const estimatedTokens = estimateTokensFromChars(text.length);
      totalBytes += bytes;
      totalLines += lines;
      totalEstimatedTokens += estimatedTokens;
      rows.push({
        path: path.relative(root, full),
        bytes,
        lineCount: lines,
        estimatedTokens,
        lastModified: stat.mtime.toISOString(),
      });
    } catch {
      // ignore unreadable file
    }
  }

  rows.sort((a, b) => b.bytes - a.bytes);

  return {
    fileCount: rows.length,
    totalBytes,
    totalLines,
    totalEstimatedTokens,
    files: rows,
    top10: rows.slice(0, 10),
    notes: 'Estimated tokens uses chars/4 heuristic.',
  };
}

function summarizeAllAgents(statusParsed, sessionsJsonText) {
  const data = JSON.parse(sessionsJsonText);
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const uniqueSessions = sessions.filter(s => !(s.key || '').includes(':run:'));

  let known = 0;
  let used = 0;
  const byModel = {};
  const byAgent = {};
  const byAgentMeta = {};
  const tokenSessions = [];

  for (const s of uniqueSessions) {
    const tok = Number(s.totalTokens);
    const updatedAt = Number(s.updatedAt);
    const model = s.model || 'unknown';
    const agent = s.agentId || 'unknown';

    if (!byAgentMeta[agent]) byAgentMeta[agent] = { lastActiveAt: null, sessions: 0 };
    byAgentMeta[agent].sessions += 1;
    if (Number.isFinite(updatedAt)) {
      if (!byAgentMeta[agent].lastActiveAt || updatedAt > byAgentMeta[agent].lastActiveAt) {
        byAgentMeta[agent].lastActiveAt = updatedAt;
      }
    }

    if (!Number.isFinite(tok)) continue;
    known += 1;
    used += tok;
    byModel[model] = (byModel[model] || 0) + tok;
    byAgent[agent] = (byAgent[agent] || 0) + tok;
    tokenSessions.push({ agent, key: s.key || '', model, tokens: tok, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null });
  }

  tokenSessions.sort((a, b) => b.tokens - a.tokens);

  return {
    capturedAt: statusParsed.capturedAt,
    securitySummary: statusParsed.securitySummary,
    securityCounts: parseSecurityCounts(statusParsed.securitySummary),
    allAgents: true,
    totalSessions: sessions.length,
    sessionCount: uniqueSessions.length,
    knownTokenSessions: known,
    estimatedUsedTokens: Math.round(used),
    estimatedCostUsd: Math.round((used / 1_000_000) * 8 * 100) / 100,
    byModelEstimatedTokens: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, v / 1000])),
    byAgentEstimatedTokens: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, v / 1000])),
    byAgentMeta,
    topSessions: tokenSessions.slice(0, 15),
    dedupeApplied: true,
  };
}

function renderHtml(history, buildId) {
  const latest = history[history.length - 1] || {};
  const prev = history[history.length - 2] || {};
  const total = Number(latest.estimatedUsedTokens || 0);
  const prevTotal = Number(prev.estimatedUsedTokens || 0);
  const delta = total - prevTotal;
  const dt = latest.capturedAt ? new Date(latest.capturedAt) : null;

  const sec = latest.securityCounts || parseSecurityCounts(latest.securitySummary || '');
  const psec = prev.securityCounts || parseSecurityCounts(prev.securitySummary || '');

  const modelEntries = Object.entries(latest.byModelEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const agentEntries = Object.entries(latest.byAgentEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const topSessions = latest.topSessions || [];
  const contextProfiler = latest.contextProfiler || { fileCount: 0, totalBytes: 0, totalLines: 0, totalEstimatedTokens: 0, files: [], top10: [] };

  const totalAgentK = agentEntries.reduce((s, [, k]) => s + Number(k || 0), 0) || 1;

  const modelRows = modelEntries.map(([m, k]) => {
    const tokens = Math.round(Number(k) * 1000);
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `<tr><td>${m}</td><td>${tokens.toLocaleString()}</td><td>${pct}%</td></tr>`;
  }).join('') || '<tr><td colspan="3">No model data</td></tr>';

  const agentRows = agentEntries.map(([a, k]) => {
    const tokens = Math.round(Number(k) * 1000);
    const pct = Math.round((Number(k) / totalAgentK) * 100);
    const prevK = Number((prev.byAgentEstimatedTokens || {})[a] || 0);
    const trend = Number(k) === prevK ? '→' : Number(k) > prevK ? '↑' : '↓';
    const meta = (latest.byAgentMeta || {})[a] || {};
    const last = meta.lastActiveAt ? new Date(meta.lastActiveAt).toLocaleString('en-GB') : 'n/a';
    return `<tr><td>${a}</td><td>${tokens.toLocaleString()}</td><td>${pct}%</td><td>${trend}</td><td>${last}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No agent data</td></tr>';

  const topRows = topSessions.map(s => {
    const key = String(s.key || '');
    const short = key.length > 64 ? key.slice(0, 64) + '…' : key;
    return `<tr><td>${s.agent || ''}</td><td title="${key.replace(/"/g, '&quot;')}">${short}</td><td>${s.model || ''}</td><td>${Math.round(Number(s.tokens || 0)).toLocaleString()}</td></tr>`;
  }).join('') || '<tr><td colspan="4">No sessions</td></tr>';

  const profilerRows = (contextProfiler.files || []).map(f => `<tr><td title="${f.path}">${f.path}</td><td data-sort="bytes">${Number(f.bytes || 0).toLocaleString()}</td><td data-sort="lines">${Number(f.lineCount || 0).toLocaleString()}</td><td data-sort="tokens">${Number(f.estimatedTokens || 0).toLocaleString()}</td><td data-sort="modified">${new Date(f.lastModified).toLocaleString('en-GB')}</td></tr>`).join('') || '<tr><td colspan="5">No context files found</td></tr>';

  const top10Rows = (contextProfiler.top10 || []).map((f, i) => `<tr><td>${i + 1}</td><td title="${f.path}">${f.path}</td><td>${Number(f.bytes || 0).toLocaleString()}</td><td>${Number(f.estimatedTokens || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No files</td></tr>';

  const historyRows = history.slice(-20).map((h, i) => `<tr><td>${i + 1}</td><td>${new Date(h.capturedAt).toLocaleString('en-GB')}</td><td>${h.sessionCount || 0}</td><td>${Math.round(Number(h.estimatedUsedTokens || 0)).toLocaleString()}</td><td>${h.securitySummary || '-'}</td></tr>`).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Usage Dashboard</title>
  <style>
    :root { --bg:#0b1020; --panel:#121a30; --panel2:#18223f; --line:#2f3d67; --text:#e7ecff; --muted:#9caad6; }
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 20% 0%, #1c2b56 0%, var(--bg) 35%);color:var(--text);font-family:Inter,system-ui,sans-serif;padding:16px}
    .container{max-width:1160px;margin:0 auto}.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:12px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.k{color:var(--muted);font-size:.8rem}.v{font-size:1.35rem;font-weight:700}
    .badge{display:inline-block;padding:4px 9px;border-radius:999px;border:1px solid var(--line);font-size:.75rem;margin-right:6px}
    table{width:100%;border-collapse:collapse} th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left} th{color:var(--muted);font-size:.8rem}
    @media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
<div class="container">
  <h1>OpenClaw Usage Dashboard</h1>
  <div class="badge">Live snapshot data • token & cost values are estimates</div>
  <div class="badge">build: ${buildId}</div>

  <div class="grid card">
    <div><div class="k">Last updated</div><div class="v">${dt ? dt.toLocaleString('en-GB') : 'n/a'}</div></div>
    <div><div class="k">Estimated tokens</div><div class="v">${total.toLocaleString()}</div></div>
    <div><div class="k">Delta vs previous</div><div class="v">${delta >= 0 ? '+' : ''}${delta.toLocaleString()}</div></div>
    <div><div class="k">Sample size</div><div class="v">${latest.knownTokenSessions || 0}/${latest.totalSessions || latest.sessionCount || 0}</div></div>
  </div>

  <div class="card"><h3>Security panel</h3>
    <div class="badge">Critical: ${sec.critical} (${(sec.critical - psec.critical) >= 0 ? '+' : ''}${sec.critical - psec.critical})</div>
    <div class="badge">Warn: ${sec.warn} (${(sec.warn - psec.warn) >= 0 ? '+' : ''}${sec.warn - psec.warn})</div>
    <div class="badge">Info: ${sec.info} (${(sec.info - psec.info) >= 0 ? '+' : ''}${sec.info - psec.info})</div>
  </div>

  <div class="card"><h3>Latest model breakdown</h3>
    <table><thead><tr><th>Model</th><th>Estimated tokens</th><th>Share</th></tr></thead><tbody>${modelRows}</tbody></table>
  </div>

  <div class="card"><h3>All-agent metrics</h3>
    <table><thead><tr><th>Agent</th><th>Estimated tokens</th><th>Share</th><th>Trend</th><th>Last active</th></tr></thead><tbody>${agentRows}</tbody></table>
  </div>

  <div class="card"><h3>Top token-consuming sessions</h3>
    <table><thead><tr><th>Agent</th><th>Session key</th><th>Model</th><th>Estimated tokens</th></tr></thead><tbody>${topRows}</tbody></table>
  </div>

  <div class="card">
    <h3>Context File Profiler</h3>
    <div class="badge">files: ${Number(contextProfiler.fileCount || 0).toLocaleString()}</div>
    <div class="badge">bytes: ${Number(contextProfiler.totalBytes || 0).toLocaleString()}</div>
    <div class="badge">lines: ${Number(contextProfiler.totalLines || 0).toLocaleString()}</div>
    <div class="badge">estimated tokens: ${Number(contextProfiler.totalEstimatedTokens || 0).toLocaleString()}</div>
    <div class="badge">${contextProfiler.notes || ''}</div>
    <table id="context-profiler-table">
      <thead><tr><th>Path</th><th>Bytes</th><th>Lines</th><th>Est. tokens</th><th>Last modified</th></tr></thead>
      <tbody>${profilerRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h3>Top-10 Heaviest Context Files</h3>
    <table><thead><tr><th>#</th><th>Path</th><th>Bytes</th><th>Est. tokens</th></tr></thead><tbody>${top10Rows}</tbody></table>
  </div>

  <div class="card"><h3>Snapshot history</h3>
    <table><thead><tr><th>#</th><th>Captured</th><th>Sessions</th><th>Estimated tokens</th><th>Security</th></tr></thead><tbody>${historyRows}</tbody></table>
  </div>
</div>
<script>
(function(){
  var table = document.getElementById('context-profiler-table');
  if (!table) return;
  var headers = table.querySelectorAll('thead th');
  headers.forEach(function(h, idx){
    if (idx === 0 || idx === 4) return;
    h.style.cursor = 'pointer';
    h.title = 'Click to sort';
    h.addEventListener('click', function(){
      var rows = Array.from(table.querySelectorAll('tbody tr'));
      var dir = h.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
      headers.forEach(function(x){ x.removeAttribute('data-dir'); });
      h.setAttribute('data-dir', dir);
      rows.sort(function(a,b){
        var av = Number((a.children[idx].textContent || '').replace(/,/g,'')) || 0;
        var bv = Number((b.children[idx].textContent || '').replace(/,/g,'')) || 0;
        return dir === 'asc' ? av - bv : bv - av;
      });
      var tbody = table.querySelector('tbody');
      rows.forEach(function(r){ tbody.appendChild(r); });
    });
  });
})();
</script>
</body>
</html>`;
}

function cmdCapture(root) {
  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const raw = run('openclaw status');
  const parsed = parseStatus(raw);
  const sessionsRaw = run('openclaw sessions --all-agents --json');
  const summary = summarizeAllAgents(parsed, sessionsRaw);
  summary.contextProfiler = buildContextProfiler(root);

  const snapshotsPath = path.join(reportsDir, 'usage-history.json');
  let history = [];
  if (fs.existsSync(snapshotsPath)) history = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'));
  history.push(summary);
  history = history.slice(-200);

  const buildId = Date.now();
  const dashboardHtml = renderHtml(history, buildId);

  fs.writeFileSync(path.join(reportsDir, 'openclaw-status.txt'), raw);
  fs.writeFileSync(path.join(reportsDir, 'usage-latest.json'), JSON.stringify({ parsed, summary, sessionsRaw }, null, 2));
  fs.writeFileSync(snapshotsPath, JSON.stringify(history, null, 2));
  fs.writeFileSync(path.join(reportsDir, 'usage-dashboard.html'), dashboardHtml);

  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'index.html'), dashboardHtml);
  fs.writeFileSync(path.join(docsDir, 'version.json'), JSON.stringify({ buildId, capturedAt: summary.capturedAt }, null, 2));

  console.log('Captured OpenClaw usage snapshot.');
  console.log(`Sessions: ${summary.sessionCount}, estimated tokens: ${summary.estimatedUsedTokens.toLocaleString()}`);
}

function main() {
  const cmd = process.argv[2] || 'capture';
  if (cmd === 'capture') return cmdCapture(process.cwd());
  console.error('Usage: node openclaw-usage.js capture');
  process.exit(1);
}

main();
