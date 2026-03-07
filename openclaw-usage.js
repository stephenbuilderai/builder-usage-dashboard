#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function run(cmd) {
  return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function capturePlanUsage(root) {
  const outPath = path.join(root, 'reports', 'plan-usage.json');
  try {
    if (fs.existsSync(outPath)) {
      const prev = safeJsonParse(fs.readFileSync(outPath, 'utf8'));
      const ageMs = prev?.capturedAt ? (Date.now() - new Date(prev.capturedAt).getTime()) : Infinity;
      // Refresh at most every 6 hours to keep overhead/cost low.
      if (Number.isFinite(ageMs) && ageMs < 6 * 60 * 60 * 1000) return prev;
    }

    const raw = run('openclaw agent --agent main --message "Run session_status and return only compact JSON: {dayLeftPercent,dayLeftText,weekLeftPercent,weekLeftText,model}. No prose." --json --timeout 90');
    const jsonStart = raw.indexOf('{');
    if (jsonStart < 0) throw new Error('No JSON in openclaw agent output');
    const wrapper = safeJsonParse(raw.slice(jsonStart));
    const textPayload = wrapper?.result?.payloads?.[0]?.text || '';
    const parsed = safeJsonParse(String(textPayload).trim());
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid session_status payload');

    const result = {
      capturedAt: new Date().toISOString(),
      source: 'openclaw-agent-session_status',
      dayLeftPercent: parsed.dayLeftPercent ?? null,
      dayLeftText: parsed.dayLeftText ?? null,
      weekLeftPercent: parsed.weekLeftPercent ?? null,
      weekLeftText: parsed.weekLeftText ?? null,
      model: parsed.model || null,
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    const fallback = {
      capturedAt: new Date().toISOString(),
      source: 'fallback',
      error: String(err?.message || err),
      dayLeftPercent: null,
      dayLeftText: null,
      weekLeftPercent: null,
      weekLeftText: null,
      model: null,
    };
    try { fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2)); } catch {}
    return fallback;
  }
}

function parseStatus(text) {
  const out = { capturedAt: new Date().toISOString(), securitySummary: '', raw: text, overview: {} };
  const sec = text.match(/Security audit\nSummary:\s*(.+)/);
  if (sec) out.securitySummary = sec[1].trim();

  // Parse the unicode table under "Overview" from `openclaw status`
  const lines = String(text || '').split(/\r?\n/);
  let inOverview = false;
  for (const line of lines) {
    if (line.trim() === 'Overview') {
      inOverview = true;
      continue;
    }
    if (inOverview && line.trim() === 'Security audit') break;
    if (!inOverview) continue;
    if (!line.includes('│')) continue;
    // table row format: │ Item │ Value │
    const parts = line.split('│').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const key = parts[0];
    const value = parts.slice(1).join(' | ');
    if (!key || key === 'Item' || /^[-─┌┬┐├┼┤└┴┘]+$/.test(key)) continue;
    out.overview[key] = value;
  }

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
    statusOverview: statusParsed.overview || {},
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
  const deltaPct = prevTotal > 0 ? (delta / prevTotal) * 100 : 0;
  const dt = latest.capturedAt ? new Date(latest.capturedAt) : null;

  const sec = latest.securityCounts || parseSecurityCounts(latest.securitySummary || '');
  const psec = prev.securityCounts || parseSecurityCounts(prev.securitySummary || '');
  const statusOverview = latest.statusOverview || {};
  const planUsage = latest.planUsage || {};
  const modelEntries = Object.entries(latest.byModelEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const agentEntries = Object.entries(latest.byAgentEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const topSessions = latest.topSessions || [];
  const contextProfiler = latest.contextProfiler || { fileCount: 0, totalBytes: 0, totalLines: 0, totalEstimatedTokens: 0, files: [], top10: [] };
  const insights = latest.aiInsights || { partial: true, last5Days: [], bullets: [], rollupLinks: [] };
  const bucketEntries = Object.entries(latest.byBucketEstimatedTokens || {}).sort((a, b) => b[1] - a[1]);
  const bucketModel = latest.byBucketByModel || {};
  const attributionRules = latest.attributionRules || {};

  const recommendedActions = [];
  if ((contextProfiler.totalEstimatedTokens || 0) > 15000) recommendedActions.push({prio:'P1',title:'Trim context footprint',body:'Top context files are inflating token load. Move archival notes out of hot context.'});
  if ((bucketEntries.find(([k]) => k === 'cron')?.[1] || 0) * 1000 > total * 0.25) recommendedActions.push({prio:'P1',title:'Reduce cron load',body:'Cron bucket exceeds 25% of burn. Merge repetitive schedules and lower frequency.'});
  if (sec.critical > 0) recommendedActions.push({prio:'P0',title:'Resolve critical findings',body:'Run deep audit and close all critical findings before optimization work.'});
  while (recommendedActions.length < 3) recommendedActions.push({prio:'P2',title:'Monitor trend variance',body:'Alert on >15% day-over-day token movement and inspect root cause.'});

  const historyTail = history.slice(-12).map(h => Number(h.estimatedUsedTokens || 0));
  const sparkMax = Math.max(...historyTail, 1);
  const sparkPoints = historyTail.map((v, i) => {
    const x = historyTail.length <= 1 ? 0 : (i / (historyTail.length - 1)) * 100;
    const y = 100 - ((v / sparkMax) * 100);
    return `${x},${y}`;
  }).join(' ');

  const modelOptions = modelEntries.map(([m]) => `<option value="${m}"></option>`).join('');
  const agentOptions = agentEntries.map(([a]) => `<option value="${a}"></option>`).join('');
  const bucketOptions = bucketEntries.map(([b]) => `<option value="${b}"></option>`).join('');

  const metricCards = [
    {label:'Token Burn (est)', value: total.toLocaleString(), trend:`${delta>=0?'+':''}${delta.toLocaleString()} (${deltaPct.toFixed(1)}%)`},
    {label:'Estimated Cost', value: `$${Number(latest.estimatedCostUsd||0).toFixed(2)}`, trend:'Heuristic based'},
    {label:'Known Token Sessions', value: `${latest.knownTokenSessions || 0}/${latest.totalSessions || latest.sessionCount || 0}`, trend:'Coverage ratio'},
    {label:'Context Weight', value: `${Number(contextProfiler.totalEstimatedTokens||0).toLocaleString()} tok`, trend:`${Number(contextProfiler.fileCount||0).toLocaleString()} files`},
  ].map(m => `<article class="MetricCard card-l2"><div class="label">${m.label}</div><div class="value">${m.value}</div><div class="hint">${m.trend}</div></article>`).join('');

  const overviewRows = [
    ['Agents', statusOverview.Agents || 'n/a'],
    ['Sessions', statusOverview.Sessions || 'n/a'],
    ['Memory', statusOverview.Memory || 'n/a'],
    ['Heartbeat', statusOverview.Heartbeat || 'n/a'],
    ['Gateway', statusOverview.Gateway || 'n/a'],
    ['Update', statusOverview.Update || 'n/a'],
    ['Codex day left', `${planUsage.dayLeftPercent ?? 'n/a'}${planUsage.dayLeftPercent != null ? '%' : ''}${planUsage.dayLeftText ? ` · ${planUsage.dayLeftText}` : ''}`],
    ['Codex week left', `${planUsage.weekLeftPercent ?? 'n/a'}${planUsage.weekLeftPercent != null ? '%' : ''}${planUsage.weekLeftText ? ` · ${planUsage.weekLeftText}` : ''}`],
    ['Plan snapshot model', planUsage.model || 'n/a'],
  ].map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const bucketVisual = bucketEntries.map(([k, valK]) => {
    const tokens = Math.round(Number(valK || 0) * 1000);
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `<div class="ranked-row" data-bucket="${k.toLowerCase()}"><div><strong>${k}</strong><span>${tokens.toLocaleString()} tokens</span></div><div class="progress"><span style="width:${pct}%"></span></div><em>${pct}%</em></div>`;
  }).join('') || '<div class="muted">No attribution data.</div>';

  const modelCards = modelEntries.map(([m,k], i) => {
    const tokens = Math.round(Number(k) * 1000);
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `<article class="InsightCard card-l2" data-model="${m.toLowerCase()}"><div class="rank">#${i+1}</div><h4>${m}</h4><div class="value-sm">${tokens.toLocaleString()} tok</div><div class="progress"><span style="width:${pct}%"></span></div><p>${pct}% of estimated burn</p></article>`;
  }).join('') || '<div class="muted">No model data.</div>';

  const bucketModelRows = Object.entries(bucketModel).map(([bucket, models]) => {
    const modelLine = Object.entries(models || {}).sort((a,b)=>b[1]-a[1]).map(([m,k]) => `${m}: ${Math.round(Number(k||0)*1000).toLocaleString()}`).join(' · ');
    return `<tr><td>${bucket}</td><td>${modelLine || 'n/a'}</td></tr>`;
  }).join('') || '<tr><td colspan="2">No bucket/model data</td></tr>';

  const agentRows = agentEntries.map(([a, k], i) => {
    const tokens = Math.round(Number(k) * 1000);
    const totalAgentK = agentEntries.reduce((s, [, val]) => s + Number(val || 0), 0) || 1;
    const pct = Math.round((Number(k) / totalAgentK) * 100);
    const prevK = Number((prev.byAgentEstimatedTokens || {})[a] || 0);
    const trend = Number(k) === prevK ? 'flat' : Number(k) > prevK ? 'up' : 'down';
    const trendGlyph = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
    const meta = (latest.byAgentMeta || {})[a] || {};
    const last = meta.lastActiveAt ? new Date(meta.lastActiveAt).toLocaleString('en-GB') : 'n/a';
    const sessions = topSessions.filter(s => s.agent === a).slice(0, 4);
    const details = sessions.map(s => `<li><code>${(s.key||'').slice(0,78)}</code><span>${Math.round(Number(s.tokens||0)).toLocaleString()} tok · ${s.model||'unknown'}</span></li>`).join('') || '<li class="muted">No session drilldown for this snapshot.</li>';
    return `<tr class="data-row" data-agent="${a.toLowerCase()}" data-sort-tokens="${tokens}" data-sort-sessions="${meta.sessions || 0}">
      <td><button class="row-toggle" data-expand="agent-${i}">${a}</button></td>
      <td>${tokens.toLocaleString()}</td>
      <td><div class="progress"><span style="width:${pct}%"></span></div><span>${pct}%</span></td>
      <td><span class="status-dot ${trend}"></span>${trendGlyph}</td>
      <td>${last}</td>
    </tr>
    <tr id="agent-${i}" class="expand-row"><td colspan="5"><div class="expand-inner"><ul>${details}</ul></div></td></tr>`;
  }).join('') || '<tr><td colspan="5">No agent data</td></tr>';

  const profilerRows = (contextProfiler.files || []).map(f => {
    const category = f.path.includes('memory/') ? 'memory' : f.path.includes('agents/') ? 'agents' : 'workspace';
    return `<tr data-path="${f.path.toLowerCase()}" data-filecat="${category}" data-sort-bytes="${Number(f.bytes||0)}"><td>${f.path}</td><td>${Number(f.bytes || 0).toLocaleString()}</td><td>${Number(f.lineCount || 0).toLocaleString()}</td><td>${Number(f.estimatedTokens || 0).toLocaleString()}</td><td>${new Date(f.lastModified).toLocaleString('en-GB')}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No context files found</td></tr>';

  const top10Rows = (contextProfiler.top10 || []).map((f, i) => `<tr><td>${i + 1}</td><td>${f.path}</td><td>${Number(f.bytes || 0).toLocaleString()}</td><td>${Number(f.estimatedTokens || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No files</td></tr>';

  const insightBullets = (insights.bullets || []).map(b => `<li>${b}</li>`).join('') || '<li>No insight bullets generated.</li>';
  const insightLinks = (insights.rollupLinks || []).map(l => `<li><a href="${l}" target="_blank" rel="noreferrer">${l}</a></li>`).join('') || '<li>No rollup links.</li>';

  const historyData = history.slice(-20).map((h, i) => ({ idx:i+1, cap:new Date(h.capturedAt).toLocaleString('en-GB'), sessions:h.sessionCount||0, tokens:Math.round(Number(h.estimatedUsedTokens||0)), security:h.securitySummary||'-' }));
  const historyRows = historyData.map((r, i) => `<tr class="hist-row" data-idx="${i}" style="display:${i<8?'':'none'}"><td>${r.idx}</td><td>${r.cap}</td><td>${r.sessions}</td><td>${r.tokens.toLocaleString()}</td><td><span class="sev-pill">${r.security}</span></td></tr>`).join('');
  const trendMax = Math.max(...historyTail,1);
  const trendMin = Math.min(...historyTail,0);
  const trendLatest = historyTail[historyTail.length-1] || 0;

  const findings = [
    {sev:'critical',cat:'Policy',src:'security audit',target:'Gateway',conf:'high',rec:'Run deep audit and patch immediately',count:sec.critical},
    {sev:'warn',cat:'Runtime',src:'usage heuristics',target:'Cron load',conf:'medium',rec:'Lower redundant schedule frequency',count:sec.warn},
    {sev:'info',cat:'Attribution',src:'classifier',target:'Session buckets',conf:'medium',rec:'Review custom key patterns',count:sec.info},
    {sev:'resolved',cat:'Delta',src:'snapshot diff',target:'Critical Δ',conf:'high',rec:`Change vs prev: ${(sec.critical-psec.critical)>=0?'+':''}${sec.critical-psec.critical}`,count:Math.max(0,(psec.critical||0)-(sec.critical||0))},
  ].map(f=>`<article class="finding ${f.sev}"><header><span class="StatusBadge ${f.sev}">${f.sev.toUpperCase()}</span><h4>${f.cat}</h4></header><dl><div><dt>Source</dt><dd>${f.src}</dd></div><div><dt>Affected</dt><dd>${f.target}</dd></div><div><dt>Confidence</dt><dd>${f.conf}</dd></div><div><dt>Count</dt><dd>${f.count}</dd></div></dl><p>${f.rec}</p></article>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Command Dashboard</title>
<style>
:root{--bg-0:#06080f;--bg-1:#0c111b;--bg-2:#111827;--surface-1:#111a2a;--surface-2:#162235;--surface-3:#1b2b42;--line:#2a3750;--line-strong:#3a4e72;--text:#edf2ff;--text-muted:#9aaccc;--text-soft:#7f91b2;--brand:#7aa2ff;--brand-soft:#4d7fe8;--accent:#4ddac6;--ok:#32c77b;--warn:#f4b955;--bad:#ef5b6f;--info:#5aa9ff;--radius:14px;--radius-lg:18px;--shadow-1:0 12px 28px rgba(0,0,0,.28);--shadow-2:0 20px 52px rgba(0,0,0,.42)}
*{box-sizing:border-box} html,body{height:100%}
body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text);background:radial-gradient(900px 420px at 12% -5%, rgba(86,124,213,.22), transparent 60%),linear-gradient(165deg,var(--bg-1),var(--bg-0));}
.app{max-width:1440px;margin:0 auto;padding:16px;display:grid;grid-template-columns:260px 1fr;gap:14px;min-height:100vh}.sidebar,.main{min-width:0}
.card-l1,.card-l2,.card-l3{border:1px solid var(--line);border-radius:var(--radius-lg);background:linear-gradient(165deg,var(--surface-1),#0f1828);box-shadow:var(--shadow-1)}.card-l2{background:linear-gradient(165deg,var(--surface-2),#121f30)}.card-l3{background:linear-gradient(165deg,var(--surface-3),#152236)}
.header{padding:16px 18px;display:flex;justify-content:space-between;gap:12px;align-items:flex-end}.title h1{margin:0;font-size:1.35rem;letter-spacing:.01em}.title p{margin:4px 0 0;color:var(--text-muted);font-size:.85rem}
.meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:center}.pill{padding:6px 10px;border:1px solid var(--line-strong);background:#122033;border-radius:999px;color:#dce7ff;font-size:.74rem}
.live{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:.8rem}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 6px rgba(50,199,123,.15)}
.nav{padding:10px}.PremiumTabs{display:flex;flex-direction:column;gap:6px}
.tabbtn{display:flex;justify-content:space-between;align-items:center;width:100%;padding:10px 12px;border-radius:12px;border:1px solid transparent;background:transparent;color:var(--text-muted);cursor:pointer;transition:.18s}.tabbtn:hover{background:#18273d;border-color:var(--line);color:var(--text)}.tabbtn.active{background:linear-gradient(160deg,#243b62,#1a2e4e);border-color:#6288d9;color:#eff5ff;box-shadow:0 0 0 2px rgba(107,144,230,.2)}
.content{display:grid;gap:12px}.HeroStatusCard{padding:16px;border:1px solid #3b5684;background:linear-gradient(160deg,#1e3154,#172741);display:flex;justify-content:space-between;gap:12px}.HeroStatusCard .state{font-size:1.5rem;font-weight:800}.HeroStatusCard .sub{color:var(--text-muted);font-size:.82rem}
.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.MetricCard{padding:12px;border-radius:var(--radius)}.MetricCard .label{font-size:.76rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.07em}.MetricCard .value{font-size:1.25rem;font-weight:800;margin-top:6px}.MetricCard .hint{font-size:.78rem;color:var(--text-muted);margin-top:4px}
.FilterToolbar{padding:12px}.filter-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px}.input,select,button{font:inherit}.input{width:100%;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:#0d1726;color:var(--text);transition:.18s}.input:hover{border-color:#49648f}.input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(122,162,255,.2)}.btn{padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:#132136;color:#dce7ff;cursor:pointer}.btn:hover{background:#1a2a41}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:.74rem;padding:4px 8px;border-radius:999px;border:1px solid var(--line);background:#13233a}
.tabsec{animation:fadeSlide .18s ease}.hidden{display:none!important}@keyframes fadeSlide{from{opacity:.3;transform:translateY(4px)}to{opacity:1;transform:none}}
.SectionHeader{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}.SectionHeader h3{margin:0;font-size:1rem}.SectionHeader p{margin:0;color:var(--text-muted);font-size:.8rem}
.DataPanel{padding:12px}.split{display:grid;grid-template-columns:1.2fr .8fr;gap:10px}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}.table-wrap table{width:100%;border-collapse:collapse;min-width:700px}
th,td{padding:9px 10px;border-bottom:1px solid #22314a;text-align:left} thead th{position:sticky;top:0;background:#101a29;z-index:1;color:var(--text-muted);font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;cursor:pointer}tbody tr:hover td{background:#16253a}
.progress{position:relative;height:8px;background:#22334d;border-radius:999px;overflow:hidden;min-width:120px;display:inline-block;vertical-align:middle;margin-right:8px}.progress>span{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--brand),var(--accent));}
.ranked-row{display:grid;grid-template-columns:1.6fr 1fr 48px;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #24344f}.ranked-row strong{display:block}.ranked-row span{color:var(--text-muted);font-size:.78rem}.ranked-row em{font-style:normal;font-size:.8rem;color:#dbe7ff;text-align:right}
.cards-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.InsightCard{padding:12px;border-radius:12px;transition:.2s}.InsightCard:hover{transform:translateY(-2px);box-shadow:var(--shadow-2)}.InsightCard .rank{font-size:.72rem;color:var(--text-soft)}.InsightCard h4{margin:4px 0}.InsightCard .value-sm{font-weight:700}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.status-dot.up{background:var(--bad)}.status-dot.down{background:var(--ok)}.status-dot.flat{background:var(--info)}
.row-toggle{background:none;border:none;color:#e7efff;padding:0;cursor:pointer;font:inherit;font-weight:600}
.expand-row{display:none}.expand-row.open{display:table-row}.expand-inner{padding:8px 0}.expand-inner ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}.expand-inner li{display:flex;justify-content:space-between;gap:10px;padding:8px;border:1px solid #2a3954;border-radius:10px;background:#121f33}.expand-inner code{color:#c9daff;font-size:.74rem}
.status-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}
.StatusBadge{font-size:.7rem;padding:3px 7px;border-radius:999px;border:1px solid}.critical{color:#ffd9df;border-color:#8d3342;background:#3b1920}.warn{color:#ffe8bf;border-color:#8e6430;background:#322615}.info{color:#d9ebff;border-color:#325c8f;background:#15263d}.resolved{color:#d0ffea;border-color:#2f7a63;background:#123228}
.findings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.finding{padding:12px;border-radius:12px;border:1px solid var(--line);background:#121f33}.finding header{display:flex;align-items:center;gap:8px}.finding h4{margin:0}.finding dl{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0}.finding dt{font-size:.72rem;color:var(--text-soft)}.finding dd{margin:0;font-size:.82rem}
.legend{color:var(--text-muted);font-size:.78rem}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.muted{color:var(--text-muted)}
.kv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kv{padding:10px;border:1px solid #2b3c59;border-radius:10px;background:#111d30}.kv .k{font-size:.72rem;color:var(--text-soft);text-transform:uppercase}.kv .v{font-size:.9rem;font-weight:700;margin-top:4px}
.chart-meta{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.chart-meta .pill{font-size:.7rem;padding:4px 8px}
.sev-pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#15263d;border:1px solid #325c8f;color:#dce9ff;font-size:.72rem}
.table-controls{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.density-toggle{display:flex;gap:6px}.density-toggle button{padding:5px 8px;border-radius:8px;border:1px solid var(--line);background:#132136;color:#dce7ff;cursor:pointer}.table-compact td,.table-compact th{padding:6px 8px}
@media (max-width:1100px){.app{grid-template-columns:1fr}.sidebar{order:2}.split,.grid4,.cards-3,.status-strip,.findings{grid-template-columns:1fr 1fr}}
@media (max-width:700px){.split,.grid4,.cards-3,.status-strip,.findings{grid-template-columns:1fr}.filter-grid{grid-template-columns:1fr}.HeroStatusCard{flex-direction:column}.app{padding:10px}}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="card-l1 nav">
      <div class="PremiumTabs">
        <button class="tabbtn active" data-tab="overview"><span>Overview</span><small>Health</small></button>
        <button class="tabbtn" data-tab="cost"><span>Cost & Model Mix</span><small>Analytics</small></button>
        <button class="tabbtn" data-tab="agents"><span>Agent Load</span><small>Operations</small></button>
        <button class="tabbtn" data-tab="context"><span>Context Footprint</span><small>Optimization</small></button>
        <button class="tabbtn" data-tab="security"><span>Security</span><small>Posture</small></button>
        <button class="tabbtn" data-tab="insights"><span>5-Day Insights</span><small>Narrative</small></button>
      </div>
    </div>
  </aside>

  <main class="main content">
    <header class="card-l1 header">
      <div class="title"><h1>OpenClaw Command Dashboard</h1><p>Operational telemetry for usage, cost, risk, and execution quality.</p></div>
      <div class="meta"><span class="pill">Live snapshot</span><span class="pill mono">build ${buildId}</span><div class="live"><span class="dot"></span>Updated ${dt ? dt.toLocaleString('en-GB') : 'n/a'}</div></div>
    </header>

    <section class="HeroStatusCard card-l2"><div><div class="label">Primary signal</div><div class="state" style="color:${Math.abs(deltaPct)>=15?'var(--bad)':'var(--ok)'}">${Math.abs(deltaPct)>=15?'Attention Required':'System Stable'}</div><div class="sub">5-second health read · burn delta ${delta>=0?'+':''}${delta.toLocaleString()} (${deltaPct.toFixed(1)}%)</div></div><div class="legend">Critical ${sec.critical} · Warn ${sec.warn} · Info ${sec.info}</div></section>
    <section class="grid4">${metricCards}</section>

    <section class="FilterToolbar card-l2"><div class="filter-grid"><input id="q" class="input" placeholder="Search sessions, files, incidents…" /><input id="fAgent" class="input" list="agentList" placeholder="Agent" /><input id="fModel" class="input" list="modelList" placeholder="Model" /><input id="fBucket" class="input" list="bucketList" placeholder="Bucket or date" /><button id="clearFilters" class="btn">Reset</button></div><datalist id="agentList">${agentOptions}</datalist><datalist id="modelList">${modelOptions}</datalist><datalist id="bucketList">${bucketOptions}</datalist><div id="filterChips" class="chips"></div></section>

    <section id="tab-overview" class="tabsec">
      <div class="split"><article class="DataPanel card-l2"><div class="SectionHeader"><h3>System Summary</h3><p>Grouped runtime signals</p></div><div class="kv-grid"><div class="kv"><div class="k">Runtime</div><div class="v">Agents ${statusOverview.Agents || 'n/a'} · Sessions ${statusOverview.Sessions || 'n/a'}</div></div><div class="kv"><div class="k">Gateway</div><div class="v">${statusOverview.Gateway || 'n/a'} · ${statusOverview.Update || 'n/a'}</div></div><div class="kv"><div class="k">Plan budget</div><div class="v">Day ${planUsage.dayLeftPercent ?? 'n/a'}% · Week ${planUsage.weekLeftPercent ?? 'n/a'}%</div></div><div class="kv"><div class="k">Model snapshot</div><div class="v mono">${planUsage.model || 'n/a'}</div></div></div><details style="margin-top:10px"><summary>Full diagnostic rows</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Signal</th><th>Value</th></tr></thead><tbody>${overviewRows}</tbody></table></div></details></article><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Trend Visualization</h3><p>Annotated burn trend</p></div><div class="chart-meta"><span class="pill">Latest ${trendLatest.toLocaleString()} tok</span><span class="pill">Range ${trendMin.toLocaleString()}–${trendMax.toLocaleString()}</span></div><svg viewBox="0 0 100 100" style="height:170px;width:100%"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#7aa2ff"/><stop offset="100%" stop-color="#4ddac6"/></linearGradient></defs><line x1="0" y1="80" x2="100" y2="80" stroke="#2b3d5e" stroke-width="1"/><line x1="0" y1="50" x2="100" y2="50" stroke="#2b3d5e" stroke-width="1"/><polyline points="${sparkPoints || '0,80 100,80'}" fill="none" stroke="url(#sg)" stroke-width="3" stroke-linecap="round"/></svg><p class="legend">12-snapshot trend with baseline guides and latest-value annotation.</p></article></div>
      <article class="DataPanel card-l2" style="margin-top:10px"><div class="SectionHeader"><h3>Bucket Share Breakdown</h3><p>Ranked load contribution</p></div>${bucketVisual}</article>
      <details class="DataPanel card-l2" style="margin-top:10px" open><summary>Snapshot History</summary><div class="table-controls"><div class="legend">Showing recent rows by default</div><button id="toggleHistory" class="btn">View all</button></div><div class="table-wrap" style="margin-top:8px"><table id="historyTable"><thead><tr><th>#</th><th>Captured</th><th>Sessions</th><th>Tokens</th><th>Security</th></tr></thead><tbody>${historyRows}</tbody></table></div></details>
    </section>

    <section id="tab-cost" class="tabsec hidden"><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Ranked Model Cards</h3><p>Comparative token contribution</p></div><div class="cards-3">${modelCards}</div></article><div class="split" style="margin-top:10px"><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Token Distribution by Bucket</h3><p>Model composition per bucket</p></div><div class="table-wrap"><table><thead><tr><th>Bucket</th><th>Model mix</th></tr></thead><tbody>${bucketModelRows}</tbody></table></div></article><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Actionable Priorities</h3><p>Execution queue</p></div>${recommendedActions.map(a=>`<article class="InsightCard card-l3"><div class="pill">${a.prio}</div><h4>${a.title}</h4><p class="muted">${a.body}</p></article>`).join('')}</article></div></section>

    <section id="tab-agents" class="tabsec hidden"><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Ranked Agent Load</h3><p>Sortable with drilldown</p></div><div class="table-wrap"><table id="agentTable"><thead><tr><th data-sort="text">Agent</th><th data-sort="num">Tokens</th><th>Share</th><th>Trend</th><th data-sort="text">Last active</th></tr></thead><tbody>${agentRows}</tbody></table></div></article></section>

    <section id="tab-context" class="tabsec hidden"><section class="grid4"><article class="MetricCard card-l2"><div class="label">Total files</div><div class="value">${Number(contextProfiler.fileCount||0).toLocaleString()}</div></article><article class="MetricCard card-l2"><div class="label">Total bytes</div><div class="value">${Number(contextProfiler.totalBytes||0).toLocaleString()}</div></article><article class="MetricCard card-l2"><div class="label">Token weight</div><div class="value">${Number(contextProfiler.totalEstimatedTokens||0).toLocaleString()}</div></article><article class="MetricCard card-l2"><div class="label">Largest offender</div><div class="value" style="font-size:.9rem">${contextProfiler.top10?.[0]?.path || 'n/a'}</div></article></section><details open class="DataPanel card-l2" style="margin-top:10px"><summary>Grouped file categories</summary><p class="legend">memory/*, agents/*, workspace root</p></details><article class="DataPanel card-l2" style="margin-top:10px"><div class="SectionHeader"><h3>Context File Table</h3><p>Sticky header + fast scan density</p></div><div class="table-wrap"><table id="contextTable"><thead><tr><th data-sort="text">Path</th><th data-sort="num">Bytes</th><th data-sort="num">Lines</th><th data-sort="num">Est tokens</th><th data-sort="text">Last modified</th></tr></thead><tbody>${profilerRows}</tbody></table></div></article><article class="DataPanel card-l2" style="margin-top:10px"><div class="SectionHeader"><h3>Top Heavy Files</h3><p>Optimization candidates</p></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Path</th><th>Bytes</th><th>Est tokens</th></tr></thead><tbody>${top10Rows}</tbody></table></div></article></section>

    <section id="tab-security" class="tabsec hidden"><section class="status-strip"><article class="MetricCard card-l2"><div class="label">Critical</div><div class="value" style="color:var(--bad)">${sec.critical}</div></article><article class="MetricCard card-l2"><div class="label">Warn</div><div class="value" style="color:var(--warn)">${sec.warn}</div></article><article class="MetricCard card-l2"><div class="label">Info</div><div class="value" style="color:var(--info)">${sec.info}</div></article><article class="MetricCard card-l2"><div class="label">Resolved</div><div class="value" style="color:var(--ok)">${Math.max(0,(psec.critical||0)-(sec.critical||0))}</div></article></section><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Incident Findings</h3><p>Severity, confidence, recommendations</p></div><div class="findings">${findings}</div><p class="legend" style="margin-top:10px">Rules: cron=${attributionRules.cron || 'n/a'} · interactive=${attributionRules.interactive || 'n/a'} · system/other=${attributionRules['system/other'] || 'n/a'}</p></article></section>

    <section id="tab-insights" class="tabsec hidden"><div class="split"><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Daily Trend Narrative</h3><p>${insights.partial ? 'Partial 5-day window' : 'Full 5-day window'}</p></div><ul>${insightBullets}</ul></article><article class="DataPanel card-l2"><div class="SectionHeader"><h3>Top Movers & Shifts</h3><p>Anomaly notes</p></div><p class="muted">Biggest shifts are extracted from rollup deltas and highlighted in trend bullets.</p></article></div><article class="DataPanel card-l2" style="margin-top:10px"><div class="SectionHeader"><h3>Exports</h3><p>Download artifacts</p></div><ul>${insightLinks}</ul><p class="legend">Summary markdown: <a href="reports/daily-rollups/summary-5d.md" target="_blank" rel="noreferrer">reports/daily-rollups/summary-5d.md</a></p></article></section>
  </main>
</div>
<script>
(function(){
  function show(tab){document.querySelectorAll('.tabsec').forEach(s=>s.classList.add('hidden'));const el=document.getElementById('tab-'+tab); if(el) el.classList.remove('hidden');document.querySelectorAll('.tabbtn').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tab));}
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));show('overview');
  function txt(v){return (v||'').toLowerCase()}
  function applyFilters(){
    const q=document.getElementById('q').value.trim();const a=document.getElementById('fAgent').value.trim();const m=document.getElementById('fModel').value.trim();const b=document.getElementById('fBucket').value.trim();
    const filters=[['Search',q],['Agent',a],['Model',m],['Bucket/Date',b]].filter(x=>x[1]);document.getElementById('filterChips').innerHTML=filters.map(function(f){return '<span class="chip">'+f[0]+': '+f[1]+'</span>';}).join('');
    document.querySelectorAll('#agentTable tbody tr.data-row').forEach(r=>{const ok = (!q || txt(r.innerText).includes(txt(q))) && (!a || txt(r.dataset.agent).includes(txt(a)));const target=document.getElementById(r.querySelector('[data-expand]').dataset.expand);r.style.display = ok ? '' : 'none';if(target) target.style.display = ok && target.classList.contains('open') ? '' : 'none';});
    document.querySelectorAll('#contextTable tbody tr').forEach(r=>{const ok = (!q || txt(r.innerText).includes(txt(q))) && (!b || txt(r.dataset.filecat||'').includes(txt(b)) || txt(r.innerText).includes(txt(b)));r.style.display = ok ? '' : 'none';});
    document.querySelectorAll('[data-model]').forEach(c=>c.style.display = (!m || txt(c.dataset.model).includes(txt(m))) ? '' : 'none');
    document.querySelectorAll('[data-bucket]').forEach(c=>c.style.display = (!b || txt(c.dataset.bucket).includes(txt(b))) ? '' : 'none');
  }
  ['q','fAgent','fModel','fBucket'].forEach(id=>document.getElementById(id).addEventListener('input',applyFilters));
  document.getElementById('clearFilters').addEventListener('click',()=>{['q','fAgent','fModel','fBucket'].forEach(id=>document.getElementById(id).value='');applyFilters();});
  document.querySelectorAll('.row-toggle').forEach(btn=>btn.addEventListener('click',()=>{const target=document.getElementById(btn.dataset.expand); if(!target) return;target.classList.toggle('open');target.style.display = target.classList.contains('open') ? '' : 'none';}));
  function makeSortable(table){if(!table) return;table.querySelectorAll('thead th[data-sort]').forEach((th,col)=>{let asc=true;th.addEventListener('click',()=>{const rows=[...table.querySelectorAll('tbody tr.data-row')];rows.sort((ra,rb)=>{const va=ra.children[col].innerText.trim(); const vb=rb.children[col].innerText.trim();if(th.dataset.sort==='num') return asc ? (parseFloat(va.replace(/[^\\d.-]/g,''))||0)-(parseFloat(vb.replace(/[^\\d.-]/g,''))||0) : (parseFloat(vb.replace(/[^\\d.-]/g,''))||0)-(parseFloat(va.replace(/[^\\d.-]/g,''))||0);return asc ? va.localeCompare(vb) : vb.localeCompare(va);});const tb=table.querySelector('tbody');rows.forEach(r=>{tb.appendChild(r); const exp=document.getElementById(r.querySelector('[data-expand]')?.dataset.expand||''); if(exp) tb.appendChild(exp);});asc=!asc;});});}
  makeSortable(document.getElementById('agentTable'));
  const historyBtn=document.getElementById('toggleHistory');
  if(historyBtn){let expanded=false;historyBtn.addEventListener('click',()=>{expanded=!expanded;document.querySelectorAll('.hist-row').forEach((r,i)=>{r.style.display=(expanded||i<8)?'':'none';});historyBtn.textContent=expanded?'Show less':'View all';});}
  const densityWrap=document.createElement('div');densityWrap.className='density-toggle';densityWrap.innerHTML='<button id="densityComfort">Comfortable</button><button id="densityCompact">Compact</button>';
  const hc=document.querySelector('#historyTable')?.closest('.table-wrap'); if(hc){const host=hc.parentElement.querySelector('.table-controls'); if(host) host.appendChild(densityWrap);}
  document.getElementById('densityCompact')?.addEventListener('click',()=>document.querySelectorAll('.table-wrap table').forEach(t=>t.classList.add('table-compact')));
  document.getElementById('densityComfort')?.addEventListener('click',()=>document.querySelectorAll('.table-wrap table').forEach(t=>t.classList.remove('table-compact')));
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
  summary.planUsage = capturePlanUsage(root);

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
