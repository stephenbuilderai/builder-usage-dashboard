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
  const m = String(cell || '').match(/([\d.]+)k\/(\d+)k/i);
  if (!m) return null;
  return { usedK: Number(m[1]), ctxK: Number(m[2]) };
}

function parseSecurityCounts(summary) {
  const s = String(summary || '');
  const pick = (k) => Number((s.match(new RegExp(`(\\d+)\\s+${k}`, 'i')) || [])[1] || 0);
  return { critical: pick('critical'), warn: pick('warn'), info: pick('info') };
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
    securityCounts: parseSecurityCounts(parsed.securitySummary),
    allAgents: false,
    totalSessions: parsed.sessions.length,
    sessionCount: parsed.sessions.length,
    knownTokenSessions: known,
    estimatedUsedTokens: Math.round(usedK * 1000),
    estimatedCostUsd: Math.round((usedK * 1000 / 1_000_000) * 8 * 100) / 100,
    byModelEstimatedTokens: byModel,
    byAgentEstimatedTokens: {},
    byAgentMeta: {},
    topSessions: [],
    dedupeApplied: false,
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
    tokenSessions.push({
      agent,
      key: s.key || 'unknown',
      model,
      tokens: tok,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null
    });
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
  const historyJson = JSON.stringify(history);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Usage Dashboard</title>
  <style>
    :root { --bg:#0b1020; --panel:#121a30; --panel2:#18223f; --line:#2f3d67; --text:#e7ecff; --muted:#9caad6; --good:#3ecf8e; --warn:#f5c451; --danger:#ff7070; --accent:#6ea8fe; }
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 20% 0%, #1c2b56 0%, var(--bg) 35%);color:var(--text);font-family:Inter,system-ui,sans-serif;padding:20px}
    .container{max-width:1180px;margin:0 auto} .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:12px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px} .k{color:var(--muted);font-size:.78rem}.v{font-size:1.35rem;font-weight:700}
    .badge{display:inline-block;padding:4px 9px;border-radius:999px;border:1px solid var(--line);font-size:.75rem;margin-right:6px}
    .success{background:#123d2c;color:#b8ffe0;border-color:#2f7255}.warning{background:#453617;color:#ffd98b;border-color:#6d5422}.danger{background:#4a1f1f;color:#ffb8b8;border-color:#7d3434}
    .toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}.btn{background:#1d2b55;color:#dbe7ff;border:1px solid #35508f;border-radius:8px;padding:6px 10px;cursor:pointer}
    .btn.active{background:#2d4f9f} table{width:100%;border-collapse:collapse;font-size:.92rem} th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left} th{color:var(--muted);font-size:.8rem}
    .bar-wrap{width:120px;height:8px;background:#22335f;border-radius:999px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}.bar{height:100%;background:linear-gradient(90deg,#5f8cff,#79d0ff)}
    .help{cursor:help;text-decoration:underline dotted}
    .chart{width:100%;height:220px;border:1px solid var(--line);border-radius:10px;background:rgba(0,0,0,.15)}
    @media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
<div class="container">
  <h1>OpenClaw Usage Dashboard</h1>
  <div class="toolbar">
    <span class="badge success">Live snapshot data • token & cost values are estimates</span>
    <span id="freshness" class="badge">freshness</span>
    <span id="sample" class="badge">sample</span>
  </div>
  <div class="toolbar">
    <strong>Period:</strong>
    <button class="btn active" data-period="24h">24h</button>
    <button class="btn" data-period="7d">7d</button>
    <button class="btn" data-period="30d">30d</button>
    <button class="btn" data-period="all">all</button>
    <button id="export-json" class="btn">Export JSON</button>
    <button id="export-csv" class="btn">Export CSV</button>
  </div>
  <div id="staleWarn"></div>
  <div class="grid card" id="kpis"></div>

  <div class="card">
    <h3>Total tokens trend</h3>
    <svg id="chart-total" class="chart" viewBox="0 0 900 220" preserveAspectRatio="none"></svg>
  </div>

  <div class="card">
    <h3>Per-model trend</h3>
    <svg id="chart-model" class="chart" viewBox="0 0 900 220" preserveAspectRatio="none"></svg>
    <div class="k">Primary configured model may differ from observed session models due to fallbacks, cron jobs, and per-agent overrides.</div>
  </div>

  <div class="card">
    <h3>Security panel</h3>
    <div id="security-panel"></div>
    <div class="k" style="margin-top:8px">Quick remediation: <code>openclaw security audit</code> · <code>openclaw security audit --deep</code> · docs: https://docs.openclaw.ai/troubleshooting</div>
  </div>

  <div class="card">
    <h3>All-agent metrics</h3>
    <div id="agent-meta" class="k" style="margin-bottom:8px"></div>
    <table><thead><tr><th>Agent</th><th>Estimated tokens</th><th>Share</th><th>Trend</th><th>Last active</th></tr></thead><tbody id="agent-table"></tbody></table>
  </div>

  <div class="card">
    <h3>Top token-consuming sessions</h3>
    <table><thead><tr><th>Agent</th><th>Session key</th><th>Model</th><th>Estimated tokens</th></tr></thead><tbody id="top-sessions"></tbody></table>
  </div>
</div>
<script>
const HISTORY = ${historyJson};
const BUILD_ID = ${buildId};
let currentPeriod = '24h';

(async function cacheBustGuard(){
  try {
    const r = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.buildId) return;
    const current = String(BUILD_ID);
    const latest = String(j.buildId);
    const url = new URL(location.href);
    const v = url.searchParams.get('v');
    if (latest !== current || v !== latest) {
      url.searchParams.set('v', latest);
      location.replace(url.toString());
    }
  } catch {}
})();

function periodFilter(rows, p){
  const now = Date.now();
  const m = { '24h': 24*3600e3, '7d': 7*24*3600e3, '30d': 30*24*3600e3 };
  if (p === 'all') return rows;
  const win = m[p] || m['24h'];
  return rows.filter(r => (now - new Date(r.capturedAt).getTime()) <= win);
}

function ago(ts){
  const sec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime())/1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  return Math.floor(sec/86400) + 'd ago';
}

function svgLine(el, points, color){
  if (!points.length) { el.innerHTML = ''; return; }
  const w=900,h=220,p=20,maxY=Math.max(...points.map(x=>x.y),1);
  const step = points.length>1 ? (w-p*2)/(points.length-1) : 0;
  const poly = points.map((pt,i)=>\`\${p+i*step},\${h-p-(pt.y/maxY)*(h-p*2)}\`).join(' ');
  const dots = points.map((pt,i)=>\`<circle cx="\${p+i*step}" cy="\${h-p-(pt.y/maxY)*(h-p*2)}" r="3" fill="#fff"><title>\${pt.label}: \${Math.round(pt.y).toLocaleString()}</title></circle>\`).join('');
  el.innerHTML = \`<polyline points="\${poly}" fill="none" stroke="\${color}" stroke-width="3"/>\${dots}\`;
}

function render(){
  const hist = periodFilter(HISTORY, currentPeriod);
  const latest = hist[hist.length-1] || HISTORY[HISTORY.length-1];
  const prev = hist.length>1 ? hist[hist.length-2] : null;
  const total = latest?.estimatedUsedTokens || 0;
  const prevTotal = prev?.estimatedUsedTokens || 0;
  const delta = total - prevTotal;

  const dt = latest ? new Date(latest.capturedAt) : null;
  const staleMs = dt ? (Date.now()-dt.getTime()) : Infinity;
  const freshNode = document.getElementById('freshness');
  freshNode.className = 'badge ' + (staleMs < 2*3600e3 ? 'success' : staleMs < 12*3600e3 ? 'warning' : 'danger');
  freshNode.textContent = !dt ? 'capture failed/no data' : staleMs < 2*3600e3 ? 'healthy data freshness' : staleMs < 12*3600e3 ? 'stale data' : 'stale >12h';

  const staleWarn = document.getElementById('staleWarn');
  staleWarn.innerHTML = staleMs > 12*3600e3 ? \`<div class="card danger">Warning: last snapshot is stale (\${ago(latest.capturedAt)}). Run capture to refresh.</div>\` : '';

  document.getElementById('sample').textContent = \`sample size: \${latest?.knownTokenSessions||0}/\${latest?.totalSessions||latest?.sessionCount||0} sessions\`;

  document.getElementById('kpis').innerHTML = \`
    <div><div class="k">Last updated</div><div class="v">\${dt ? dt.toLocaleString('en-GB',{timeZoneName:'short'}) : 'n/a'}</div><div class="k">\${latest ? ago(latest.capturedAt) : ''}</div></div>
    <div><div class="k">Estimated tokens</div><div class="v">\${Math.round(total).toLocaleString()}</div><div class="k">vs previous snapshot <span class="help" title="Delta compares current selected-period latest snapshot with the immediate previous snapshot in that same period.">ⓘ</span></div></div>
    <div><div class="k">Delta (vs previous snapshot)</div><div class="v" style="color:\${delta>=0?'#3ecf8e':'#ff8181'}">\${delta>=0?'+':''}\${Math.round(delta).toLocaleString()}</div></div>
    <div><div class="k">Estimated cost (rough)</div><div class="v">$\${(latest?.estimatedCostUsd||0).toFixed(2)}</div><div class="k">rough estimate only</div></div>
  \`;

  svgLine(document.getElementById('chart-total'), hist.map(h => ({ y:h.estimatedUsedTokens||0, label:new Date(h.capturedAt).toLocaleString()})), '#6ea8fe');

  const modelChart = document.getElementById('chart-model');
  const models = Array.from(new Set(hist.flatMap(h => Object.keys(h.byModelEstimatedTokens||{}))));
  const colors = ['#6ea8fe','#f5c451','#3ecf8e','#ff8db4','#b89cff'];
  const w=900,h=220,p=20;
  const maxY=Math.max(...hist.flatMap(hh => models.map(m => (hh.byModelEstimatedTokens?.[m]||0)*1000)),1);
  const step = hist.length>1 ? (w-p*2)/(hist.length-1):0;
  let lines='';
  models.forEach((m,idx)=>{
    const poly = hist.map((hh,i)=>\`\${p+i*step},\${h-p-(((hh.byModelEstimatedTokens?.[m]||0)*1000)/maxY)*(h-p*2)}\`).join(' ');
    lines += \`<polyline points="\${poly}" fill="none" stroke="\${colors[idx%colors.length]}" stroke-width="2"><title>\${m}</title></polyline>\`;
  });
  modelChart.innerHTML = lines;

  const sec = latest?.securityCounts || {critical:0,warn:0,info:0};
  const psec = prev?.securityCounts || {critical:0,warn:0,info:0};
  document.getElementById('security-panel').innerHTML = \`
    <span class="badge danger">Critical: \${sec.critical} (\${(sec.critical-psec.critical)>=0?'+':''}\${sec.critical-psec.critical})</span>
    <span class="badge warning">Warn: \${sec.warn} (\${(sec.warn-psec.warn)>=0?'+':''}\${sec.warn-psec.warn})</span>
    <span class="badge">Info: \${sec.info} (\${(sec.info-psec.info)>=0?'+':''}\${sec.info-psec.info})</span>
    <span class="badge">new since last snapshot where parseable</span>
  \`;

  const agents = Object.entries(latest?.byAgentEstimatedTokens || {}).sort((a,b)=>b[1]-a[1]);
  const prevAgents = Object.fromEntries(Object.entries(prev?.byAgentEstimatedTokens || {}));
  const totalAgentTokens = agents.reduce((a,[,k])=>a+k,0) || 1;
  const meta = latest?.byAgentMeta || {};
  document.getElementById('agent-meta').textContent = \`allAgents=\${latest?.allAgents===true} · dedupe(:run:)=\${latest?.dedupeApplied===true}\`;
  document.getElementById('agent-table').innerHTML = agents.map(([agent, tokK])=>{
    const t = Math.round(tokK*1000); const pct=Math.round((tokK/totalAgentTokens)*100);
    const prevTok = Number(prevAgents[agent]||0); const d = tokK-prevTok;
    const trend = d===0?'→':d>0?'↑':'↓';
    const last = meta[agent]?.lastActiveAt ? new Date(meta[agent].lastActiveAt).toLocaleString('en-GB',{timeZoneName:'short'}) : 'n/a';
    return \`<tr><td>\${agent}</td><td>\${t.toLocaleString()}</td><td><span class='bar-wrap'><span class='bar' style='width:\${pct}%'></span></span>\${pct}%</td><td>\${trend} \${Math.round(d*1000).toLocaleString()}</td><td>\${last}</td></tr>\`;
  }).join('') || '<tr><td colspan="5">No data</td></tr>';

  const top = (latest?.topSessions || []);
  document.getElementById('top-sessions').innerHTML = top.map(s => \`<tr><td>\${s.agent}</td><td title='\${s.key}'>\${s.key.length>52?s.key.slice(0,52)+'…':s.key}</td><td>\${s.model}</td><td>\${Math.round(s.tokens).toLocaleString()}</td></tr>\`).join('') || '<tr><td colspan="4">No sessions</td></tr>';
}

document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-period]').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  currentPeriod = b.getAttribute('data-period');
  render();
}));

document.getElementById('export-json').addEventListener('click',()=>{
  const blob = new Blob([JSON.stringify(HISTORY,null,2)],{type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='usage-history.json'; a.click(); URL.revokeObjectURL(a.href);
});

document.getElementById('export-csv').addEventListener('click',()=>{
  const rows = [['capturedAt','estimatedUsedTokens','estimatedCostUsd','sessionCount','knownTokenSessions','securitySummary']]
    .concat(HISTORY.map(h=>[h.capturedAt,h.estimatedUsedTokens,h.estimatedCostUsd,h.sessionCount,h.knownTokenSessions,JSON.stringify(h.securitySummary||'')]));
  const csv = rows.map(r=>r.map(v=>\`"\${String(v??'').replace(/"/g,'""')}"\`).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='usage-history.csv'; a.click(); URL.revokeObjectURL(a.href);
});

render();
</script>
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
    summary = summarize(parsed);
  }

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
  console.log('Synced reports/usage-dashboard.html -> docs/index.html');
}

function main() {
  const root = process.cwd();
  const cmd = process.argv[2] || 'capture';
  if (cmd === 'capture') return cmdCapture(root);
  console.error('Usage: node openclaw-usage.js capture');
  process.exit(1);
}

main();
