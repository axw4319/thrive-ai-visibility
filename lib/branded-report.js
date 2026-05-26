// Thrive-branded HTML report for AI Visibility scan results.
// Renders standalone (no JS deps) so Puppeteer URL→PDF produces a clean branded PDF.
// Visual style mirrors thrive-report-app's Altus PDF (green #7D963D, orange #FF6600).

const LOGO_URL = "https://thriveagency.com/wp-content/themes/thrive-agency/images/thrive-orange.svg";

const PALETTE = [
  '#7D963D', '#FF6600', '#0984e3', '#e17055', '#fdcb6e', '#e84393',
  '#00cec9', '#d63031', '#a29bfe', '#55efc4', '#fab1a0', '#74b9ff',
  '#ffeaa7', '#fd79a8', '#81ecec', '#ff7675', '#636e72', '#b2bec3',
];

function brandColor(name, map) {
  if (map[name]) return map[name];
  const idx = Object.keys(map).length % PALETTE.length;
  map[name] = PALETTE[idx];
  return map[name];
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function monthYear() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function donutSVG(items, size = 220) {
  const cx = size / 2, cy = size / 2, r = size * 0.34, r2 = size * 0.20;
  const total = items.reduce((s, i) => s + i.val, 0) || 1;
  let cum = 0, slices = '', labels = [];
  items.forEach(item => {
    const pct = item.val / total;
    const a1 = cum * 2 * Math.PI - Math.PI / 2; cum += pct;
    const a2 = cum * 2 * Math.PI - Math.PI / 2;
    const large = pct > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const ix1 = cx + r2 * Math.cos(a2), iy1 = cy + r2 * Math.sin(a2);
    const ix2 = cx + r2 * Math.cos(a1), iy2 = cy + r2 * Math.sin(a1);
    slices += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} L${ix1.toFixed(1)},${iy1.toFixed(1)} A${r2},${r2} 0 ${large} 0 ${ix2.toFixed(1)},${iy2.toFixed(1)} Z" fill="${item.color}"/>`;
    const mid = (a1 + a2) / 2;
    labels.push({
      name: item.name, pct: (item.val * 100).toFixed(1), isTarget: item.isTarget,
      ax: cx + r * Math.cos(mid), ay: cy + r * Math.sin(mid),
      lx: cx + (r + 22) * Math.cos(mid), ly: cy + (r + 22) * Math.sin(mid),
      isRight: Math.cos(mid) >= 0,
    });
  });
  let labelSvg = '';
  labels.forEach(l => {
    const anchor = l.isRight ? 'start' : 'end';
    const fw = l.isTarget ? 'bold' : 'normal';
    labelSvg += `<line x1="${l.ax.toFixed(1)}" y1="${l.ay.toFixed(1)}" x2="${l.lx.toFixed(1)}" y2="${l.ly.toFixed(1)}" stroke="#bbb" stroke-width="0.7"/>`;
    labelSvg += `<text x="${l.lx.toFixed(1)}" y="${l.ly.toFixed(1)}" font-size="9" font-weight="${fw}" fill="#444" text-anchor="${anchor}" dominant-baseline="middle">${esc(l.name)} ${l.pct}%</text>`;
  });
  return `<svg viewBox="-60 -10 ${size + 120} ${size + 20}" width="${size + 120}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${slices}${labelSvg}</svg>`;
}

function renderBrandedReportHTML(report, scanId) {
  const scan = report.scan || {};
  const target = report.target || { visibility_pct: 0, mention_count: 0, market_share_pct: 0 };
  const metrics = report.metrics || [];
  const models = report.models || [];
  const promptResults = report.prompt_results || [];
  const tName = scan.brand_name || 'Your Brand';
  const tNorm = (tName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const colorMap = {};
  metrics.forEach(m => brandColor(m.brand_name, colorMap));
  brandColor(tName, colorMap);

  const sortedByVis = [...metrics].sort((a, b) => (b.visibility_pct || 0) - (a.visibility_pct || 0));
  const me = sortedByVis.find(m => m.normalized_name === tNorm)
    || { brand_name: tName, normalized_name: tNorm, visibility_pct: 0, market_share_pct: 0, mention_count: 0, avg_rank: 0, avg_sentiment: 0 };
  const leader = sortedByVis[0] || me;
  const gap = ((leader.visibility_pct || 0) - (me.visibility_pct || 0)).toFixed(1);

  let top10 = sortedByVis.slice(0, 10);
  if (!top10.find(r => r.normalized_name === tNorm) && me.visibility_pct >= 0) top10.push(me);
  const barMax = Math.max(...top10.map(r => r.visibility_pct || 0), 1);

  const sovItems = sortedByVis.filter(r => (r.market_share_pct || 0) > 0).slice(0, 6).map(r => ({
    name: r.brand_name,
    val: Math.max(r.market_share_pct / 100, 0.001),
    color: brandColor(r.brand_name, colorMap),
    isTarget: r.normalized_name === tNorm,
  }));
  if (sovItems.length && !sovItems.find(s => s.isTarget)) {
    sovItems.push({ name: tName, val: Math.max(me.market_share_pct / 100, 0.001), color: brandColor(tName, colorMap), isTarget: true });
  }

  // Reputation from avg_sentiment (-1..1) → 0..100
  const repScore = me.avg_sentiment != null ? Math.round(((me.avg_sentiment + 1) / 2) * 100) : '-';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Visibility Report — ${esc(tName)}</title>
<meta property="og:title" content="${esc(tName)} AI Visibility Report">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', -apple-system, system-ui, sans-serif; background: #fff; color: #1a1a2e; padding: 40px; max-width: 920px; margin: 0 auto; }
  .rh { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid #7D963D; padding-bottom: 16px; margin-bottom: 20px; }
  .rh .meta { flex: 1; }
  .rh .tl { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #7D963D; margin-bottom: 4px; }
  .rh h1 { font-size: 26px; font-weight: 700; color: #1a1a2e; letter-spacing: -0.02em; line-height: 1.1; }
  .rh .dr { font-size: 11px; color: #888; margin-top: 4px; }
  .rh .rlogo { height: 42px; max-width: 160px; }
  .url-row { font-size: 11px; color: #777; margin-bottom: 24px; }
  .url-row a { color: #FF6600; text-decoration: none; font-weight: 500; }
  .mr { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 24px; }
  .mc { background: #f8faf4; border: 1px solid #e3ebd4; border-radius: 8px; padding: 14px 12px; text-align: center; }
  .mc .v { font-size: 22px; font-weight: 700; color: #7D963D; line-height: 1.1; }
  .mc .l { font-size: 9px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 5px; }
  .rs { margin-bottom: 26px; page-break-inside: avoid; }
  .rs h3 { font-size: 14px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; border-left: 4px solid #FF6600; padding-left: 10px; }
  .ss { font-size: 10px; color: #888; margin-bottom: 12px; padding-left: 14px; }
  .co { background: #f0f5e6; border-left: 4px solid #7D963D; padding: 10px 14px; font-size: 12px; color: #555; border-radius: 0 7px 7px 0; margin-bottom: 14px; }
  .co b { color: #7D963D; }
  .bc { display: grid; grid-template-columns: repeat(11, 1fr); gap: 6px; align-items: end; height: 170px; padding: 6px 0; border-bottom: 1px solid #eee; }
  .bg { display: flex; flex-direction: column; align-items: center; gap: 4px; min-height: 100%; justify-content: end; }
  .bg .bpct { font-size: 9px; font-weight: 700; color: #555; }
  .bg .bbar { width: 100%; min-height: 2px; border-radius: 4px 4px 0 0; }
  .bg .bl { font-size: 8px; color: #888; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
  .bg .bl.target { color: #7D963D; font-weight: 700; }
  .bt { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
  .bt th { text-align: left; padding: 8px 10px; background: #f8f8f8; color: #555; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 2px solid #7D963D; }
  .bt td { padding: 9px 10px; border-bottom: 1px solid #f2f2f2; }
  .bt tr:last-child td { border: none; }
  .bt .rk { font-weight: 700; color: #7D963D; width: 28px; }
  .bt .bn { font-weight: 600; color: #1a1a2e; }
  .bt .nm { font-family: 'Space Mono', monospace; font-size: 11px; color: #555; }
  .bt tr.hl { background: #fffaf2; }
  .vis-bar { display: inline-block; width: 100px; height: 7px; background: #f2f2f2; border-radius: 4px; vertical-align: middle; margin-right: 8px; position: relative; overflow: hidden; }
  .vis-bar .fill { height: 100%; border-radius: 3px; background: #7D963D; position: absolute; left: 0; top: 0; }
  .sent-bar { display: inline-block; width: 64px; height: 7px; background: #f2f2f2; border-radius: 4px; margin-right: 8px; position: relative; overflow: hidden; vertical-align: middle; }
  .sent-bar .fill { height: 100%; border-radius: 3px; background: #FF6600; position: absolute; left: 0; top: 0; }
  .pt { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 10px; }
  .pt th { text-align: left; padding: 6px 8px; background: #f8f8f8; color: #555; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 2px solid #7D963D; }
  .pt td { padding: 6px 8px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
  .donut-wrap { display: flex; gap: 24px; align-items: center; }
  .donut-legend { font-size: 11px; color: #555; }
  .donut-legend div { padding: 4px 0; }
  .donut-legend div span { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; vertical-align: middle; }
  .footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #eee; font-size: 9px; color: #aaa; text-align: center; }
  .footer a { color: #FF6600; text-decoration: none; }
  .engines { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .engines .eng { background: #fff8f0; color: #FF6600; border: 1px solid #ffd9b3; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  @media print {
    body { padding: 24px; }
    .rs { page-break-inside: avoid; }
  }
</style>
</head><body>
<div class="rh">
  <div class="meta">
    <div class="tl">AI Search Visibility Analysis</div>
    <h1>${esc(tName).toUpperCase()}</h1>
    <div class="dr">${monthYear()} · Scan #${esc(scanId)} · Powered by Thrive Internet Marketing Agency</div>
  </div>
  <img class="rlogo" src="${LOGO_URL}" alt="Thrive Agency">
</div>

<div class="url-row">Analyzed: <a href="${esc(scan.website_url)}" target="_blank">${esc(scan.website_url)}</a> ${scan.industry ? '· ' + esc(scan.industry) : ''}</div>

<div class="mr">
  <div class="mc"><div class="v">${(target.visibility_pct || 0).toFixed(1)}%</div><div class="l">AI Visibility</div></div>
  <div class="mc"><div class="v">${repScore}</div><div class="l">Reputation</div></div>
  <div class="mc"><div class="v">${(target.market_share_pct || 0).toFixed(1)}%</div><div class="l">Market Share</div></div>
  <div class="mc"><div class="v">${metrics.length}</div><div class="l">Brands Tracked</div></div>
  <div class="mc"><div class="v">${models.length}</div><div class="l">AI Engines</div></div>
</div>

<div class="co">
  ${leader.normalized_name !== tNorm
    ? `★ <b>${esc(leader.brand_name)}</b> leads the AI search landscape at ${(leader.visibility_pct || 0).toFixed(1)}% visibility — <b>${gap}%</b> ahead of ${esc(tName)}.`
    : `★ <b>${esc(tName)}</b> leads the competitive landscape at ${(me.visibility_pct || 0).toFixed(1)}% AI visibility.`}
  <div class="engines">${models.map(m => `<span class="eng">${esc(m.replace(/_/g, ' '))}</span>`).join('')}</div>
</div>

${top10.length ? `<div class="rs">
  <h3>AI Visibility Comparison</h3>
  <div class="ss">The percentage your brand is mentioned across all tracked AI engine answers</div>
  <div class="bc">${top10.map(r => `
    <div class="bg">
      <div class="bpct">${(r.visibility_pct || 0).toFixed(1)}%</div>
      <div class="bbar" style="height:${Math.max(2, ((r.visibility_pct || 0) / barMax) * 130)}px;background:${brandColor(r.brand_name, colorMap)}"></div>
      <div class="bl${r.normalized_name === tNorm ? ' target' : ''}">${esc((r.brand_name || '').split(' ').slice(0, 2).join(' '))}</div>
    </div>`).join('')}
  </div>
</div>` : ''}

${sovItems.length ? `<div class="rs">
  <h3>Market Share</h3>
  <div class="ss">Your share of voice in AI answers vs competitors</div>
  <div class="donut-wrap">
    ${donutSVG(sovItems, 170)}
    <div class="donut-legend">
      ${sovItems.map(s => `<div${s.isTarget ? ' style="font-weight:700"' : ''}><span style="background:${s.color}"></span>${esc(s.name)} ${(s.val * 100).toFixed(1)}%</div>`).join('')}
    </div>
  </div>
</div>` : ''}

<div class="rs">
  <h3>Top Competitors</h3>
  <div class="ss">Brands ranked by AI visibility across ${models.length} AI engines</div>
  <table class="bt">
    <thead><tr><th>#</th><th>Brand</th><th>Visibility</th><th>Market Share</th><th>Mentions</th><th>Avg. Position</th><th>Reputation</th></tr></thead>
    <tbody>
    ${sortedByVis.slice(0, 15).map((r, i) => {
      const rep = r.avg_sentiment != null ? Math.round(((r.avg_sentiment + 1) / 2) * 100) : '-';
      return `<tr class="${r.normalized_name === tNorm ? 'hl' : ''}">
        <td class="rk">${i + 1}</td>
        <td class="bn">${r.normalized_name === tNorm ? '<b>' + esc(r.brand_name) + '</b>' : esc(r.brand_name)}</td>
        <td><span class="vis-bar"><span class="fill" style="width:${Math.min(100, ((r.visibility_pct || 0) / Math.max(barMax, 1)) * 100)}%"></span></span><span class="nm">${(r.visibility_pct || 0).toFixed(1)}%</span></td>
        <td class="nm">${(r.market_share_pct || 0).toFixed(1)}%</td>
        <td class="nm">${(r.mention_count || 0).toLocaleString()}</td>
        <td class="nm">${r.avg_rank ? r.avg_rank.toFixed(1) : '-'}</td>
        <td><span class="sent-bar"><span class="fill" style="width:${Math.min(100, rep === '-' ? 0 : rep)}%"></span></span><span class="nm">${rep}</span></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>
</div>

${promptResults.length ? `<div class="rs">
  <h3>Top Search Prompts Tested</h3>
  <div class="ss">Real AI prompts your brand was scored against. ${esc(tName)}'s visibility shown per prompt.</div>
  <table class="pt">
    <thead><tr><th>#</th><th>Prompt</th><th>${esc(tName)}<br>Visibility</th><th>Top Brands Mentioned</th></tr></thead>
    <tbody>
    ${promptResults.slice(0, 20).map((p, i) => `
      <tr>
        <td class="rk">${i + 1}</td>
        <td>${esc((p.prompt || '').slice(0, 140))}${(p.prompt || '').length > 140 ? '…' : ''}</td>
        <td class="nm" style="font-weight:700;color:#7D963D">${(p.visibility_pct || 0).toFixed(1)}%</td>
        <td>${esc((p.top_brands || []).slice(0, 3).join(', '))}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>` : ''}

<div class="footer">
  Generated by Thrive Internet Marketing Agency — AI Visibility Scanner ·
  <a href="https://thriveagency.com">thriveagency.com</a> · ${monthYear()}
</div>
</body></html>`;
}

module.exports = { renderBrandedReportHTML };
