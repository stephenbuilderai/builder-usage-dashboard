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

function summarizeAllAgents(statusParsed, sessionsJsonText) {
  const data = JSON.parse(sessionsJsonText);
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  // Drop synthetic run-keys to avoid double counting parent + run rows.
  const uniqueSessions = sessions.filter(s => !(s.key || '').includes(':run:'));

  let known = 0;
  let used = 0;
  const byModel = {};
  const byAgent = {};

  for (const s of uniqueSessions) {
    const tok = Number(s.totalTokens);
    if (!Number.isFinite(tok)) continue;
    known += 1;
    used += tok;
    const model = s.model || 'unknown';
    byModel[model] = (byModel[model] || 0) + tok;
    const agent = s.agentId || 'unknown';
    byAgent[agent] = (byAgent[agent] || 0) + tok;
  }

  return {
    capturedAt: statusParsed.capturedAt,
    securitySummary: statusParsed.securitySummary,
    allAgents: true,
    sessionCount: uniqueSessions.length,
    knownTokenSessions: known,
    estimatedUsedTokens: Math.round(used),
    byModelEstimatedTokens: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, v / 1000])),
    byAgentEstimatedTokens: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, v / 1000])),
  };
}

function renderHtml(history) {
  const latest = history[history.length - 1] || null;
  const previous = history.length > 1 ? history[history.length - 2] : null;

  const totalNow = latest ? latest.estimatedUsedTokens : 0;
  const totalPrev = previous ? previous.estimatedUsedTokens : 0;
  const delta = totalNow - totalPrev;
  const deltaPct = totalPrev > 0 ? (delta / totalPrev) * 100 : 0;

  const modelEntries = latest
    ? Object.entries(latest.byModelEstimatedTokens || {}).sort((a, b) => b[1] - a[1])
    : [];

  const modelRows = modelEntries
    .map(([model, usedK]) => {
      const tokens = Math.round(usedK * 1000);
      const percent = totalNow > 0 ? Math.round((tokens / totalNow) * 100) : 0;
      return `<tr>
        <td>${model}</td>
        <td>${tokens.toLocaleString()}</td>
        <td>
          <div class="bar-wrap"><div class="bar" style="width:${percent}%"></div></div>
          <span class="bar-label">${percent}%</span>
        </td>
      </tr>`;
    })
    .join('');

  const historyRows = history
    .map((h, i) => {
      const risk = h.securitySummary || '-';
      return `<tr>
        <td>${i + 1}</td>
        <td>${new Date(h.capturedAt).toLocaleString()}</td>
        <td>${h.sessionCount}</td>
        <td>${h.estimatedUsedTokens.toLocaleString()}</td>
        <td>${risk}</td>
      </tr>`;
    })
    .join('');

  const points = history.map((h, idx) => ({
    x: idx,
    y: h.estimatedUsedTokens,
    label: new Date(h.capturedAt).toLocaleString()
  }));

  const maxY = Math.max(...points.map((p) => p.y), 1);
  const width = 900;
  const height = 260;
  const pad = 24;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;

  const polyline = points
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = height - pad - ((p.y / maxY) * (height - pad * 2));
      return `${x},${y}`;
    })
    .join(' ');

  const dots = points
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = height - pad - ((p.y / maxY) * (height - pad * 2));
      return `<circle cx="${x}" cy="${y}" r="4"><title>${p.label}: ${p.y.toLocaleString()} tokens</title></circle>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Usage Dashboard</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #121a30;
      --panel-2: #18223f;
      --text: #e7ecff;
      --muted: #9caad6;
      --line: #2f3d67;
      --accent: #6ea8fe;
      --good: #3ecf8e;
      --warn: #f5c451;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(circle at 20% 0%, #1c2b56 0%, var(--bg) 35%);
      color: var(--text);
      min-height: 100vh;
      padding: 32px 18px;
    }
    .container { max-width: 1160px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 1.9rem; }
    .sub { color: var(--muted); margin-bottom: 22px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
    .card {
      background: linear-gradient(180deg, var(--panel-2), var(--panel));
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 6px 30px rgba(0,0,0,.25);
    }
    .k { color: var(--muted); font-size: .82rem; }
    .v { margin-top: 6px; font-size: 1.4rem; font-weight: 700; }
    .delta.up { color: var(--good); }
    .delta.down { color: #ff8181; }
    .section { margin-top: 14px; }
    .section h2 { font-size: 1.05rem; margin: 0 0 10px; }
    .chart-wrap { overflow: auto; }
    .chart {
      width: 100%; min-width: 480px; background: rgba(13, 19, 36, .65);
      border: 1px solid var(--line); border-radius: 12px; padding: 8px;
    }
    .chart polyline { fill: none; stroke: var(--accent); stroke-width: 3; }
    .chart circle { fill: #fff; stroke: var(--accent); stroke-width: 2; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    th { color: var(--muted); font-weight: 600; font-size: .86rem; }
    .bar-wrap { display: inline-block; width: 120px; height: 8px; background: #22335f; border-radius: 999px; margin-right: 8px; overflow: hidden; }
    .bar { height: 100%; background: linear-gradient(90deg, #5f8cff, #79d0ff); }
    .bar-label { color: var(--muted); font-size: .78rem; }
    .pill {
      display: inline-block; padding: 4px 8px; border-radius: 999px;
      border: 1px solid var(--line); background: rgba(255,255,255,.03); color: var(--muted); font-size: .76rem;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>OpenClaw Usage Dashboard</h1>
    <div class="sub">Auto-generated from <code>openclaw status</code> snapshots.</div>

    <div class="grid">
      <div class="card">
        <div class="k">Snapshots</div>
        <div class="v">${history.length}</div>
      </div>
      <div class="card">
        <div class="k">Latest Estimated Tokens</div>
        <div class="v">${totalNow.toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="k">Delta vs Previous</div>
        <div class="v ${delta >= 0 ? 'delta up' : 'delta down'}">${delta >= 0 ? '+' : ''}${delta.toLocaleString()}</div>
        <div class="k">${totalPrev > 0 ? `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%` : 'n/a'}</div>
      </div>
      <div class="card">
        <div class="k">Latest Sessions</div>
        <div class="v">${latest ? latest.sessionCount : 0}</div>
      </div>
    </div>

    <div class="card section">
      <h2>Usage Trend</h2>
      <div class="chart-wrap">
        <svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Usage trend chart">
          <polyline points="${polyline}" />
          ${dots}
        </svg>
      </div>
    </div>

    <div class="card section">
      <h2>Latest Model Breakdown</h2>
      <table>
        <thead><tr><th>Model</th><th>Estimated Tokens</th><th>Share</th></tr></thead>
        <tbody>${modelRows || '<tr><td colspan="3">No model data yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card section">
      <h2>Snapshot History</h2>
      <div class="pill">Security: ${latest?.securitySummary || 'n/a'}</div>
      <table>
        <thead><tr><th>#</th><th>Captured</th><th>Sessions</th><th>Estimated Tokens</th><th>Security Summary</th></tr></thead>
        <tbody>${historyRows || '<tr><td colspan="5">No history yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

function cmdCapture(root) {
  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const raw = run('openclaw status');
  const parsed = parseStatus(raw);

  let summary;
  let sessionsRaw = '';
  try {
    sessionsRaw = run('openclaw sessions --all-agents --json');
    summary = summarizeAllAgents(parsed, sessionsRaw);
  } catch {
    // Fallback to legacy top-table parse if sessions JSON is unavailable.
    summary = summarize(parsed);
  }

  const snapshotsPath = path.join(reportsDir, 'usage-history.json');
  let history = [];
  if (fs.existsSync(snapshotsPath)) {
    history = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'));
  }
  history.push(summary);
  history = history.slice(-50);

  fs.writeFileSync(path.join(reportsDir, 'openclaw-status.txt'), raw);
  fs.writeFileSync(path.join(reportsDir, 'usage-latest.json'), JSON.stringify({ parsed, summary, sessionsRaw }, null, 2));
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
