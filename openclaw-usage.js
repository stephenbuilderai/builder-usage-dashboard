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
  const byBucketEstimatedTokens = { cron: 0, interactive: 0, 'system/other': 0 };
  const byBucketByModel = { cron: {}, interactive: {}, 'system/other': {} };

  for (const s of uniqueSessions) {
    const tok = Number(s.totalTokens);
    const updatedAt = Number(s.updatedAt);
    const model = s.model || 'unknown';
    const agent = s.agentId || 'unknown';
    const key = String(s.key || '');
    const kind = String(s.kind || '');

    let bucket = 'system/other';
    if (key.includes(':cron:')) bucket = 'cron';
    else if (key.includes(':telegram:') || key.includes(':discord:') || kind === 'group' || kind === 'direct' || key.includes(':main')) bucket = 'interactive';

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
    byBucketEstimatedTokens[bucket] = (byBucketEstimatedTokens[bucket] || 0) + tok;
    byBucketByModel[bucket][model] = (byBucketByModel[bucket][model] || 0) + tok;
    tokenSessions.push({ agent, key: s.key || '', model, tokens: tok, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null, bucket });
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
    byBucketEstimatedTokens: Object.fromEntries(Object.entries(byBucketEstimatedTokens).map(([k, v]) => [k, v / 1000])),
    byBucketByModel: Object.fromEntries(
      Object.entries(byBucketByModel).map(([bucket, models]) => [
        bucket,
        Object.fromEntries(Object.entries(models).map(([m, v]) => [m, v / 1000]))
      ])
    ),
    attributionRules: {
      cron: 'session key contains :cron:',
      interactive: 'telegram/discord/group/direct/main session patterns',
      'system/other': 'fallback bucket when no other rule matches',
      limitations: 'Pattern-based heuristics; may misclassify custom keys or future formats.'
    },
    topSessions: tokenSessions.slice(0, 15),
    dedupeApplied: true,
  };
}

function toDay(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function ensureDailyRollups(root, history) {
  const dir = path.join(root, 'reports', 'daily-rollups');
  fs.mkdirSync(dir, { recursive: true });

  const byDay = new Map();
  for (const snap of history) {
    const day = toDay(snap.capturedAt || new Date().toISOString());
    const prev = byDay.get(day);
    if (!prev || new Date(snap.capturedAt) > new Date(prev.capturedAt)) byDay.set(day, snap);
  }

  const days = Array.from(byDay.keys()).sort();
  for (const day of days) {
    const s = byDay.get(day);
    const payload = {
      date: day,
      capturedAt: s.capturedAt,
      tokens: s.estimatedUsedTokens || 0,
      estimatedCostUsd: s.estimatedCostUsd || 0,
      byModel: s.byModelEstimatedTokens || {},
      byAgent: s.byAgentEstimatedTokens || {},
      attributionBuckets: s.byBucketEstimatedTokens || {},
      securityCounts: s.securityCounts || {},
      contextProfilerTotals: s.contextProfiler ? {
        fileCount: s.contextProfiler.fileCount || 0,
        totalBytes: s.contextProfiler.totalBytes || 0,
        totalLines: s.contextProfiler.totalLines || 0,
        totalEstimatedTokens: s.contextProfiler.totalEstimatedTokens || 0,
      } : {},
    };
    fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(payload, null, 2));
  }

  const last5 = days.slice(-5).map(d => ({ day: d, snap: byDay.get(d) }));
  const tokenSeries = last5.map(x => Number(x.snap.estimatedUsedTokens || 0));
  const totalDelta = tokenSeries.length > 1 ? tokenSeries[tokenSeries.length - 1] - tokenSeries[0] : 0;

  const sumBy = (arr, field) => {
    const out = {};
    for (const x of arr) {
      for (const [k, v] of Object.entries(x.snap[field] || {})) out[k] = (out[k] || 0) + Number(v || 0);
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 3);
  };

  const topModels = sumBy(last5, 'byModelEstimatedTokens');
  const topAgents = sumBy(last5, 'byAgentEstimatedTokens');
  const topBuckets = sumBy(last5, 'byBucketEstimatedTokens');

  const anomalies = [];
  for (let i = 1; i < tokenSeries.length; i++) {
    const prevT = tokenSeries[i - 1] || 1;
    const pct = ((tokenSeries[i] - prevT) / prevT) * 100;
    if (Math.abs(pct) >= 15) anomalies.push(`${last5[i].day}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% token shift vs previous day`);
  }

  const md = [
    '# 5-day AI Insights',
    '',
    `Window: ${last5[0]?.day || 'n/a'} → ${last5[last5.length - 1]?.day || 'n/a'} (${last5.length} day(s))`,
    '',
    '## Trend narrative',
    `- Estimated tokens moved ${totalDelta >= 0 ? 'up' : 'down'} by ${Math.abs(totalDelta).toLocaleString()} across the available window.`,
    `- Estimated daily costs track token movement and remain rough heuristics.`,
    '',
    '## Biggest drivers',
    `- Top models: ${topModels.map(([k, v]) => `${k} (${Math.round(v * 1000).toLocaleString()} est tokens)`).join(' · ') || 'n/a'}`,
    `- Top agents: ${topAgents.map(([k, v]) => `${k} (${Math.round(v * 1000).toLocaleString()} est tokens)`).join(' · ') || 'n/a'}`,
    `- Top attribution buckets: ${topBuckets.map(([k, v]) => `${k} (${Math.round(v * 1000).toLocaleString()} est tokens)`).join(' · ') || 'n/a'}`,
    '',
    '## Anomalies',
    ...(anomalies.length ? anomalies.map(a => `- ${a}`) : ['- No strong day-over-day anomalies detected (>=15% threshold).']),
    '',
    '## Recommended actions',
    '- Cap high-churn context files and trim non-essential markdown to reduce prompt footprint.',
    '- Review cron-heavy windows and reduce redundant scheduled runs where possible.',
    '- Keep fallback model usage visible; investigate spikes when model mix changes suddenly.',
    '',
    '_Note: generated from local snapshot artifacts using heuristic summarization (LLM-style narrative)._',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'summary-5d.md'), md);

  return {
    rollupDir: dir,
    daysAvailable: days.length,
    daysUsed: last5.length,
    last5Days: last5.map(x => x.day),
    partial: last5.length < 5,
    summaryPath: path.join(dir, 'summary-5d.md'),
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
  const insights = latest.aiInsights || { partial: true, last5Days: [], bullets: [], rollupLinks: [] };
  const bucketEntries = Object.entries(latest.byBucketEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const bucketModel = latest.byBucketByModel || {};
  const attributionRules = latest.attributionRules || {};

  const totalAgentK = agentEntries.reduce((s, [, k]) => s + Number(k || 0), 0) || 1;
  const topBurner = topSessions[0] || {};
  const anomaly = Math.abs(prevTotal) > 0 && Math.abs((delta / prevTotal) * 100) >= 15;
  const historyTail = history.slice(-12).map(h => Number(h.estimatedUsedTokens || 0));
  const sparkMax = Math.max(...historyTail, 1);
  const sparkPoints = historyTail.map((v, i) => {
    const x = historyTail.length <= 1 ? 0 : (i / (historyTail.length - 1)) * 100;
    const y = 100 - ((v / sparkMax) * 100);
    return `${x},${y}`;
  }).join(' ');

  const recommendedActions = [];
  if ((contextProfiler.totalEstimatedTokens || 0) > 15000) recommendedActions.push('Trim high-size context markdown files (top-10 card) to reduce prompt load.');
  if ((bucketEntries.find(([k]) => k === 'cron')?.[1] || 0) * 1000 > total * 0.25) recommendedActions.push('Cron bucket is heavy — reduce redundant scheduled runs or lower frequency.');
  if (sec.critical > 0) recommendedActions.push('Address security critical findings first (`openclaw security audit --deep`).');
  while (recommendedActions.length < 3) recommendedActions.push('Monitor daily rollups and act on >15% day-over-day token spikes.');

  const modelRows = modelEntries.map(([m, k]) => {
    const tokens = Math.round(Number(k) * 1000);
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `<tr data-model="${m.toLowerCase()}"><td>${m}</td><td>${tokens.toLocaleString()}</td><td>${pct}%</td></tr>`;
  }).join('') || '<tr><td colspan="3">No model data</td></tr>';

  const agentRows = agentEntries.map(([a, k]) => {
    const tokens = Math.round(Number(k) * 1000);
    const pct = Math.round((Number(k) / totalAgentK) * 100);
    const prevK = Number((prev.byAgentEstimatedTokens || {})[a] || 0);
    const trend = Number(k) === prevK ? '→' : Number(k) > prevK ? '↑' : '↓';
    const meta = (latest.byAgentMeta || {})[a] || {};
    const last = meta.lastActiveAt ? new Date(meta.lastActiveAt).toLocaleString('en-GB') : 'n/a';
    return `<tr data-agent="${a.toLowerCase()}"><td>${a}</td><td>${tokens.toLocaleString()}</td><td><span class="bar"><span style="width:${pct}%"></span></span>${pct}%</td><td>${trend}</td><td>${last}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No agent data</td></tr>';

  const topRows = topSessions.map(s => {
    const key = String(s.key || '');
    const short = key.length > 64 ? key.slice(0, 64) + '…' : key;
    return `<tr data-agent="${(s.agent || '').toLowerCase()}" data-model="${(s.model || '').toLowerCase()}" data-bucket="${(s.bucket || '').toLowerCase()}"><td>${s.agent || ''}</td><td title="${key.replace(/"/g, '&quot;')}">${short}</td><td>${s.model || ''}</td><td>${Math.round(Number(s.tokens || 0)).toLocaleString()}</td><td>${s.bucket || 'n/a'}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No sessions</td></tr>';

  const bucketRows = bucketEntries.map(([bucket, valK]) => {
    const tokens = Math.round(Number(valK || 0) * 1000);
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `<tr data-bucket="${bucket.toLowerCase()}"><td>${bucket}</td><td>${tokens.toLocaleString()}</td><td>${pct}%</td></tr>`;
  }).join('') || '<tr><td colspan="3">No attribution data</td></tr>';

  const bucketModelRows = Object.entries(bucketModel).map(([bucket, models]) => {
    const modelLine = Object.entries(models || {}).sort((a,b)=>b[1]-a[1]).map(([m,k]) => `${m}: ${Math.round(Number(k||0)*1000).toLocaleString()}`).join(' · ');
    return `<tr><td>${bucket}</td><td>${modelLine || 'n/a'}</td></tr>`;
  }).join('') || '<tr><td colspan="2">No bucket/model data</td></tr>';

  const profilerRows = (contextProfiler.files || []).map(f => `<tr data-path="${f.path.toLowerCase()}"><td title="${f.path}">${f.path}</td><td>${Number(f.bytes || 0).toLocaleString()}</td><td>${Number(f.lineCount || 0).toLocaleString()}</td><td>${Number(f.estimatedTokens || 0).toLocaleString()}</td><td>${new Date(f.lastModified).toLocaleString('en-GB')}</td></tr>`).join('') || '<tr><td colspan="5">No context files found</td></tr>';
  const top10Rows = (contextProfiler.top10 || []).map((f, i) => `<tr><td>${i + 1}</td><td title="${f.path}">${f.path}</td><td>${Number(f.bytes || 0).toLocaleString()}</td><td>${Number(f.estimatedTokens || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No files</td></tr>';

  const insightBullets = (insights.bullets || []).map(b => `<li>${b}</li>`).join('') || '<li>No insight bullets generated.</li>';
  const insightLinks = (insights.rollupLinks || []).map(l => `<li><a href="${l}" target="_blank" rel="noreferrer">${l}</a></li>`).join('') || '<li>No rollup links.</li>';
  const historyRows = history.slice(-20).map((h, i) => `<tr><td>${i + 1}</td><td>${new Date(h.capturedAt).toLocaleString('en-GB')}</td><td>${h.sessionCount || 0}</td><td>${Math.round(Number(h.estimatedUsedTokens || 0)).toLocaleString()}</td><td>${h.securitySummary || '-'}</td></tr>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Usage Dashboard</title>
<style>
:root{--bg:#070b16;--bg2:#0f1630;--panel:#111a31cc;--panel2:#1a284acc;--line:#2f426fcc;--text:#edf2ff;--muted:#9fb1dc;--accent:#74a8ff;--accent2:#79e3ff;--ok:#88e7b8;--bad:#ff8080}
*{box-sizing:border-box}
body{margin:0;color:var(--text);font-family:Inter,system-ui,sans-serif;padding:16px;line-height:1.4;background:radial-gradient(circle at 15% 0%, #243d7d 0%, var(--bg2) 30%, var(--bg) 60%);min-height:100vh}
body:before{content:"";position:fixed;inset:-20% -10%;pointer-events:none;background:conic-gradient(from 0deg at 50% 50%,rgba(116,168,255,.08),rgba(121,227,255,.06),rgba(145,115,255,.08),rgba(116,168,255,.08));filter:blur(70px);animation:spin 26s linear infinite;z-index:-1}
@keyframes spin{to{transform:rotate(360deg)}}
.container{max-width:1240px;margin:0 auto}
.card{background:linear-gradient(170deg,var(--panel2),var(--panel));backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:12px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.hero{display:flex;align-items:end;justify-content:space-between;gap:10px;flex-wrap:wrap}
.h-title{font-size:1.6rem;font-weight:800;letter-spacing:.2px}
.h-sub{color:var(--muted);font-size:.85rem;margin-top:4px}
.k{color:var(--muted);font-size:.78rem}.v{font-size:1.45rem;font-weight:800}
.badge{display:inline-block;padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:#0f1730c7;font-size:.75rem;margin:4px 6px 0 0}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.strip .card{margin-top:0}
.tabs{display:flex;flex-wrap:wrap;gap:8px}
.tabbtn{padding:8px 12px;border:1px solid #385493;border-radius:999px;background:linear-gradient(180deg,#1b2b52,#141f3d);color:#e4eeff;font-size:.84rem;cursor:pointer;transition:all .18s ease}
.tabbtn:hover{transform:translateY(-1px);border-color:#6d96ff;box-shadow:0 0 0 3px rgba(116,168,255,.14)}
table{width:100%;border-collapse:collapse}
th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
tr:hover td{background:rgba(255,255,255,.02)}
summary{cursor:pointer;color:#cfe0ff}
.hidden{display:none}
.bar{display:inline-block;width:120px;height:8px;background:#233560;border-radius:999px;overflow:hidden;margin-right:6px;vertical-align:middle}
.bar>span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.filter{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px}
.input{width:100%;padding:9px;border-radius:10px;border:1px solid var(--line);background:#0f1730;color:var(--text)}
.spark{height:70px;width:100%;margin-top:8px;background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01));border:1px solid var(--line);border-radius:12px;padding:6px}
.spark svg{width:100%;height:100%}
.spark polyline{fill:none;stroke:url(#g);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 8px rgba(121,227,255,.4))}
@media(max-width:900px){.strip{grid-template-columns:repeat(2,minmax(0,1fr))}.filter{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="container">
  <div class="card hero">
    <div>
      <div class="h-title">OpenClaw Executive Dashboard</div>
      <div class="h-sub">Operational token intelligence • premium live view</div>
      <div class="badge">Live snapshot data • token/cost are estimates</div><div class="badge">build: ${buildId}</div>
    </div>
    <div class="k">Last updated: ${dt ? dt.toLocaleString('en-GB') : 'n/a'}</div>
  </div>

  <div class="strip" style="margin-top:12px">
    <div class="card"><div class="k">Estimated cost today</div><div class="v">$${Number(latest.estimatedCostUsd||0).toFixed(2)}</div></div>
    <div class="card"><div class="k">Estimated tokens today</div><div class="v">${total.toLocaleString()}</div></div>
    <div class="card"><div class="k">Top burner</div><div class="v" style="font-size:1rem">${topBurner.agent || 'n/a'}</div><div class="k">${(topBurner.key||'n/a').slice(0,38)}</div></div>
    <div class="card"><div class="k">Anomaly / regression flag</div><div class="v" style="color:${anomaly ? 'var(--bad)' : 'var(--ok)'}">${anomaly ? 'ALERT' : 'normal'}</div><div class="k">Δ ${delta>=0?'+':''}${delta.toLocaleString()} vs prev</div></div>
  </div>

  <div class="card tabs">
    <button class="tabbtn" data-tab="overview">Overview</button>
    <button class="tabbtn" data-tab="cost">Cost & Models</button>
    <button class="tabbtn" data-tab="agents">Agents</button>
    <button class="tabbtn" data-tab="context">Context Files</button>
    <button class="tabbtn" data-tab="security">Security</button>
    <button class="tabbtn" data-tab="insights">Insights</button>
  </div>

  <div class="card filter">
    <input id="q" class="input" placeholder="Search session/file text" />
    <input id="fAgent" class="input" placeholder="Filter agent" />
    <input id="fModel" class="input" placeholder="Filter model" />
    <input id="fBucket" class="input" placeholder="Filter bucket/date" />
  </div>

  <section id="tab-overview" class="card tabsec"><h3>Overview</h3>
    <div class="k">Sample ${latest.knownTokenSessions || 0}/${latest.totalSessions || latest.sessionCount || 0} sessions</div>
    <div class="spark" title="Recent token trend (last 12 snapshots)">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#74a8ff"/><stop offset="100%" stop-color="#79e3ff"/></linearGradient></defs>
        <polyline points="${sparkPoints || '0,80 100,80'}"></polyline>
      </svg>
    </div>
    <table><thead><tr><th>Bucket</th><th>Estimated tokens</th><th>Share</th></tr></thead><tbody id="bucketTable">${bucketRows}</tbody></table>
    <details><summary>Snapshot history (expanded on demand)</summary><table><thead><tr><th>#</th><th>Captured</th><th>Sessions</th><th>Estimated tokens</th><th>Security</th></tr></thead><tbody>${historyRows}</tbody></table></details>
  </section>

  <section id="tab-cost" class="card tabsec hidden"><h3>Cost & Models</h3>
    <table id="modelTable"><thead><tr><th>Model</th><th>Estimated tokens</th><th>Share</th></tr></thead><tbody>${modelRows}</tbody></table>
    <details><summary>Per-model within attribution buckets</summary><table><thead><tr><th>Bucket</th><th>Models</th></tr></thead><tbody>${bucketModelRows}</tbody></table></details>
    <div class="card"><h4>Recommended Actions (top 3)</h4><ul><li>${recommendedActions[0]}</li><li>${recommendedActions[1]}</li><li>${recommendedActions[2]}</li></ul></div>
  </section>

  <section id="tab-agents" class="card tabsec hidden"><h3>Agents</h3>
    <table id="agentTable"><thead><tr><th>Agent</th><th>Estimated tokens</th><th>Share</th><th>Trend</th><th>Last active</th></tr></thead><tbody>${agentRows}</tbody></table>
    <details><summary>Top token-consuming sessions</summary><table id="sessionTable"><thead><tr><th>Agent</th><th>Session key</th><th>Model</th><th>Estimated tokens</th><th>Bucket</th></tr></thead><tbody>${topRows}</tbody></table></details>
  </section>

  <section id="tab-context" class="card tabsec hidden"><h3>Context Files</h3>
    <div class="badge">files: ${Number(contextProfiler.fileCount || 0).toLocaleString()}</div><div class="badge">bytes: ${Number(contextProfiler.totalBytes || 0).toLocaleString()}</div><div class="badge">lines: ${Number(contextProfiler.totalLines || 0).toLocaleString()}</div><div class="badge">estimated tokens: ${Number(contextProfiler.totalEstimatedTokens || 0).toLocaleString()}</div>
    <details open><summary>Context File Profiler</summary><table id="contextTable"><thead><tr><th>Path</th><th>Bytes</th><th>Lines</th><th>Est. tokens</th><th>Last modified</th></tr></thead><tbody>${profilerRows}</tbody></table></details>
    <details><summary>Top-10 Heaviest Context Files</summary><table><thead><tr><th>#</th><th>Path</th><th>Bytes</th><th>Est. tokens</th></tr></thead><tbody>${top10Rows}</tbody></table></details>
  </section>

  <section id="tab-security" class="card tabsec hidden"><h3>Security</h3>
    <div class="badge">Critical: ${sec.critical} (${(sec.critical - psec.critical) >= 0 ? '+' : ''}${sec.critical - psec.critical})</div>
    <div class="badge">Warn: ${sec.warn} (${(sec.warn - psec.warn) >= 0 ? '+' : ''}${sec.warn - psec.warn})</div>
    <div class="badge">Info: ${sec.info} (${(sec.info - psec.info) >= 0 ? '+' : ''}${sec.info - psec.info})</div>
    <div class="k">Attribution rules: cron=${attributionRules.cron || 'n/a'} · interactive=${attributionRules.interactive || 'n/a'} · system/other=${attributionRules['system/other'] || 'n/a'}</div>
  </section>

  <section id="tab-insights" class="card tabsec hidden"><h3>Insights</h3>
    <h4>5-day AI Insights ${insights.partial ? '(partial window)' : ''}</h4><div class="badge">days used: ${(insights.last5Days || []).length}/5</div>
    <ul>${insightBullets}</ul>
    <h4>Rollups & Exports</h4>
    <ul>${insightLinks}</ul>
    <div class="k">Preserved exports and rollup links are available above.</div>
  </section>
</div>
<script>
(function(){
  function show(tab){document.querySelectorAll('.tabsec').forEach(s=>s.classList.add('hidden'));var el=document.getElementById('tab-'+tab);if(el)el.classList.remove('hidden');}
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>show(b.getAttribute('data-tab'))));
  show('overview');

  function ftxt(v){return (v||'').toLowerCase()}
  function apply(){
    var q=ftxt(document.getElementById('q').value),a=ftxt(document.getElementById('fAgent').value),m=ftxt(document.getElementById('fModel').value),b=ftxt(document.getElementById('fBucket').value);
    [['#sessionTable tbody tr',q,a,m,b],['#contextTable tbody tr',q,'','','']].forEach(function(set){
      document.querySelectorAll(set[0]).forEach(function(r){
        var txt=ftxt(r.innerText); var ok=true;
        if(set[1] && !txt.includes(set[1])) ok=false;
        if(set[2] && !ftxt(r.getAttribute('data-agent')).includes(set[2])) ok=false;
        if(set[3] && !ftxt(r.getAttribute('data-model')).includes(set[3])) ok=false;
        if(set[4] && !ftxt(r.getAttribute('data-bucket')).includes(set[4]) && !txt.includes(set[4])) ok=false;
        r.style.display=ok?'':'none';
      });
    });
  }
  ['q','fAgent','fModel','fBucket'].forEach(id=>{var x=document.getElementById(id); if(x) x.addEventListener('input',apply)});
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

  const rollupMeta = ensureDailyRollups(root, history);
  let summaryMd = '';
  try { summaryMd = fs.readFileSync(rollupMeta.summaryPath, 'utf8'); } catch {}
  const bulletLines = summaryMd.split('\n').filter(l => l.startsWith('- ')).slice(0, 6).map(l => l.replace(/^-\s*/, ''));
  summary.aiInsights = {
    partial: rollupMeta.partial,
    last5Days: rollupMeta.last5Days,
    bullets: bulletLines,
    rollupLinks: rollupMeta.last5Days.map(d => `reports/daily-rollups/${d}.json`),
    summaryPath: 'reports/daily-rollups/summary-5d.md',
  };
  history[history.length - 1] = summary;

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

  // Mirror rollups into docs for GitHub Pages links.
  const docsRollups = path.join(docsDir, 'reports', 'daily-rollups');
  fs.mkdirSync(docsRollups, { recursive: true });
  const srcRollups = path.join(root, 'reports', 'daily-rollups');
  if (fs.existsSync(srcRollups)) {
    for (const file of fs.readdirSync(srcRollups)) {
      fs.copyFileSync(path.join(srcRollups, file), path.join(docsRollups, file));
    }
  }

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
