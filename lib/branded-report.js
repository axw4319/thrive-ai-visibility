// Thrive-branded HTML report for AI Visibility scan results.
// Mirrors thrive-report-app's Altus PDF template (lib/pdf-generator.js)
// exactly — same CSS, same section order, same color palette, same logo.
// Rendered by /report/:id and converted to PDF by the URL-to-PDF gateway.

const LOGO = require('./thrive-logo');

const PALETTE = [
  '#7D963D', '#00b894', '#e17055', '#0984e3', '#fdcb6e', '#e84393',
  '#00cec9', '#d63031', '#a29bfe', '#55efc4', '#fab1a0', '#74b9ff',
  '#ffeaa7', '#fd79a8', '#81ecec', '#ff7675', '#636e72', '#b2bec3',
  '#2d3436', '#dfe6e9',
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

// Format a 0..1 ratio as "12.3%"
function pf(v) {
  return (Number(v) * 100).toFixed(1) + '%';
}

function monthYear() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Donut SVG (copied from Altus pdf-generator.js)
function donutSVG(items, size) {
  size = size || 220;
  const cx = size / 2, cy = size / 2, r = size * 0.34, r2 = size * 0.20;
  const total = items.reduce((s, i) => s + i.val, 0) || 1;
  let cum = 0, slices = '';
  const labels = [];

  items.forEach(item => {
    const pct = item.val / total;
    const a1 = cum * 2 * Math.PI - Math.PI / 2; cum += pct;
    const a2 = cum * 2 * Math.PI - Math.PI / 2;
    const mid = (a1 + a2) / 2;
    const anchorX = cx + r * Math.cos(mid);
    const anchorY = cy + r * Math.sin(mid);
    const isRight = anchorX >= cx;
    const labelR = r + 22;
    labels.push({
      name: item.name, pctVal: (item.val * 100).toFixed(1), isTarget: item.isTarget,
      anchorX, anchorY,
      lx: cx + labelR * Math.cos(mid),
      ly: cy + labelR * Math.sin(mid),
      isRight, color: item.color,
    });
  });

  const leftLabels = labels.filter(l => !l.isRight).sort((a, b) => a.ly - b.ly);
  const rightLabels = labels.filter(l => l.isRight).sort((a, b) => a.ly - b.ly);
  function spread(arr) { for (let i = 1; i < arr.length; i++) { if (arr[i].ly - arr[i - 1].ly < 12) arr[i].ly = arr[i - 1].ly + 12; } }
  spread(leftLabels); spread(rightLabels);

  cum = 0;
  items.forEach(item => {
    const pct = item.val / total;
    const a1 = cum * 2 * Math.PI - Math.PI / 2; cum += pct;
    const a2 = cum * 2 * Math.PI - Math.PI / 2;
    const large = pct > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const ix1 = cx + r2 * Math.cos(a2), iy1 = cy + r2 * Math.sin(a2);
    const ix2 = cx + r2 * Math.cos(a1), iy2 = cy + r2 * Math.sin(a1);
    slices += `<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${ix1},${iy1} A${r2},${r2} 0 ${large} 0 ${ix2},${iy2} Z" fill="${item.color}"/>`;
  });

  let labelsSvg = '';
  labels.forEach(l => {
    const endX = l.isRight ? l.lx - 4 : l.lx + 4;
    labelsSvg += `<line x1="${l.anchorX}" y1="${l.anchorY}" x2="${endX}" y2="${l.ly}" stroke="#bbb" stroke-width="0.7"/>`;
    const anchor = l.isRight ? 'start' : 'end';
    const fw = l.isTarget ? 'bold' : 'normal';
    labelsSvg += `<text x="${l.lx}" y="${l.ly}" font-size="8" font-weight="${fw}" fill="#444" text-anchor="${anchor}" dominant-baseline="middle">${esc(l.name)} ${l.pctVal}%</text>`;
  });

  const vw = size + 120, vh = size + 20;
  return `<svg viewBox="-60 -10 ${vw} ${vh}" width="${vw}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${slices}${labelsSvg}</svg>`;
}

// Adapter: scan data (visibility_pct in 0..100) → Altus shape (vis in 0..1)
function scanToAltusRows(report) {
  const tNorm = (report.scan.brand_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = (report.metrics || []).map(m => ({
    id: m.normalized_name,
    name: m.brand_name,
    vis: (m.visibility_pct || 0) / 100,
    sov: (m.market_share_pct || 0) / 100,
    mentions: m.mention_count || 0,
    pos: m.avg_rank || 0,
    sent: m.avg_sentiment != null ? Math.round(((m.avg_sentiment + 1) / 2) * 100) : 0,
    visTotal: 0,
  }));
  rows.sort((a, b) => b.vis - a.vis);
  return { rows, tNorm };
}

function renderBrandedReportHTML(report, scanId) {
  const scan = report.scan || {};
  const target = report.target || { visibility_pct: 0, mention_count: 0, market_share_pct: 0 };
  const models = report.models || [];
  const modelBreakdown = report.model_breakdown || {};
  const promptResults = report.prompt_results || [];
  const tN = scan.brand_name || 'Your Brand';
  const colorMap = {};

  const { rows, tNorm } = scanToAltusRows(report);
  rows.forEach(r => brandColor(r.name, colorMap));
  brandColor(tN, colorMap);

  const me = rows.find(r => r.id === tNorm) || {
    id: tNorm, name: tN,
    vis: (target.visibility_pct || 0) / 100,
    sov: (target.market_share_pct || 0) / 100,
    mentions: target.mention_count || 0,
    pos: 0,
    sent: target.avg_sentiment != null ? Math.round(((target.avg_sentiment + 1) / 2) * 100) : 0,
  };
  if (!rows.find(r => r.id === tNorm)) rows.push(me);
  const leader = rows[0] || me;
  const gap = ((leader.vis - me.vis) * 100).toFixed(1);

  let top10 = rows.slice(0, 10);
  if (!top10.find(r => r.id === tNorm)) top10.push(me);
  const barMax = Math.max(...top10.map(r => r.vis), 0.01);

  const sovF = rows.filter(r => r.sov > 0);
  let sovTop = sovF.slice(0, 6);
  if (!sovTop.find(r => r.id === tNorm)) sovTop.push({ ...me, sov: Math.max(me.sov, 0.001) });

  // Visibility-by-AI-model: { model_name: [{ name, count }] } from assembleReport
  const mBreak = [];
  const legendBrands = new Set();
  Object.entries(modelBreakdown).forEach(([modelName, brands]) => {
    if (!brands || !brands.length) return;
    const maxCount = Math.max(...brands.map(b => b.count || 0), 1);
    const items = brands.slice(0, 5).map(b => ({
      id: (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      name: b.name,
      vis: (b.count || 0) / maxCount,  // normalize for bar height within this model
    }));
    if (!items.find(i => i.id === tNorm)) items.push({ id: tNorm, name: tN, vis: 0 });
    items.forEach(i => legendBrands.add(i.name));
    mBreak.push({ model: modelName, items });
  });
  legendBrands.add(tN);

  const totalConvo = (report.total_prompts || promptResults.length || 0) * models.length;

  const reportBody = `
    <div class="rh">
      <div class="tl">AI Search Visibility Analysis</div>
      <h1>${esc(tN).toUpperCase()}</h1>
      <div class="dr">${monthYear()} · Scan #${esc(scanId)}</div>
      <img class="rlogo" src="${LOGO}" alt="Thrive">
    </div>
    <div class="mr">
      <div class="mc"><div class="v">${pf(me.vis)}</div><div class="l">AI Visibility</div></div>
      <div class="mc"><div class="v">${me.sent || '-'}</div><div class="l">Reputation</div></div>
      <div class="mc"><div class="v">${pf(me.sov)}</div><div class="l">Market Share</div></div>
      <div class="mc"><div class="v">${rows.length}</div><div class="l">Brands Tracked</div></div>
      <div class="mc"><div class="v">${totalConvo.toLocaleString()}</div><div class="l">Conversations</div></div>
    </div>
    <div class="rs" style="padding-bottom:0">
      <div class="co">${leader.id !== me.id
        ? `★ <b>${esc(leader.name)}</b> leads at ${pf(leader.vis)}, ${gap}% ahead of ${esc(me.name)}.`
        : `★ <b>${esc(me.name)}</b> leads the competitive landscape at ${pf(me.vis)} visibility.`}
      </div>
    </div>
    <div class="rs">
      <h3>AI Visibility Comparison</h3>
      <div class="ss">The percentage your brand is mentioned in all tracked AI answers</div>
      <div class="bc">${top10.map(r => `
        <div class="bg">
          <div class="bpct">${pf(r.vis)}</div>
          <div class="bbar" style="height:${Math.max(2, (r.vis / barMax) * 120)}px;background:${brandColor(r.name, colorMap)}"></div>
          <div class="bl${r.id === tNorm ? ' target' : ''}">${esc((r.name || '').split(' ').slice(0, 2).join(' '))}</div>
        </div>`).join('')}
      </div>
    </div>
    ${sovTop.length ? `<div class="rs">
      <h3>Market Share</h3>
      <div class="ss">The percentage your brand is mentioned in AI answers compared to your competitors</div>
      <div class="donut-wrap">${donutSVG(sovTop.map(r => ({
        name: r.name,
        val: Math.max(r.sov, 0.001),
        color: brandColor(r.name, colorMap),
        isTarget: r.id === tNorm,
      })), 170)}
      <div class="donut-legend">${sovTop.map(r => `<div${r.id === tNorm ? ' style="font-weight:700"' : ''}><span style="background:${brandColor(r.name, colorMap)}"></span>${esc(r.name)} ${(r.sov * 100).toFixed(1)}%</div>`).join('')}</div></div>
    </div>` : ''}
    ${mBreak.length ? `<div class="rs">
      <h3>Visibility by AI Model</h3>
      <div class="ss">Top brands across AI models</div>
      <div class="mb">${mBreak.slice(0, 5).map(m => `
        <div class="mi">
          <div class="mn">${esc(m.model.replace(/_/g, ' '))}</div>
          <div class="mm">${m.items.map(it => `<div class="mmb" style="height:${Math.max(it.id === tNorm ? 2 : 6, Math.min(50, it.vis * 50))}px;background:${brandColor(it.name, colorMap)}"></div>`).join('')}</div>
        </div>`).join('')}
      </div>
      <div class="model-legend">${[...legendBrands].map(n => `<div class="ml-item"><div class="ml-dot" style="background:${brandColor(n, colorMap)}"></div><span${n === tN ? ' style="font-weight:700"' : ''}>${esc(n)}</span></div>`).join('')}</div>
    </div>` : ''}
    <div class="rs">
      <h3>Top Competitors</h3>
      <div class="ss">Competitors ranked by AI Visibility</div>
      <table class="bt">
        <thead><tr><th>#</th><th>Brand</th><th>Visibility</th><th>Market Share</th><th>Mentions</th><th>Avg. Position</th><th>Reputation</th></tr></thead>
        <tbody>
        ${rows.map((r, i) => `<tr class="${r.id === tNorm ? 'hl' : ''}">
          <td class="rk">${i + 1}</td>
          <td class="bn">${r.id === tNorm ? '<b>' + esc(r.name) + '</b>' : esc(r.name)}</td>
          <td><span class="vis-bar"><span class="fill" style="width:${barMax > 0 ? Math.min(100, (r.vis / barMax) * 100) : 0}%"></span></span><span class="nm">${pf(r.vis)}</span></td>
          <td class="nm">${pf(r.sov)}</td>
          <td class="nm">${(r.mentions || 0).toLocaleString()}</td>
          <td class="nm">${r.pos ? r.pos.toFixed(1) : '-'}</td>
          <td><span class="sent-bar"><span class="fill" style="width:${Math.min(100, r.sent || 0)}%"></span></span><span class="nm">${r.sent || '-'}</span></td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${promptResults.length ? `<div class="rs">
      <h3>Top Search Prompts</h3>
      <div class="ss">Prompts your brand was scored against</div>
      <table class="pt">
        <thead><tr><th>#</th><th>Query</th><th>${esc(tN)}<br>Visibility</th><th>Leaders</th></tr></thead>
        <tbody>
        ${promptResults.slice(0, 20).map((p, i) => `
          <tr>
            <td class="rk">${i + 1}</td>
            <td class="pq">${esc(p.prompt || '')}</td>
            <td class="nm" style="font-weight:700;color:#7D963D">${(p.visibility_pct || 0).toFixed(1)}%</td>
            <td class="leaders-cell">${(p.top_competitors || []).map(l => l.toLowerCase() === tN.toLowerCase() ? '<b style="color:#7D963D">' + esc(l) + '</b>' : esc(l)).join(', ')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}
    <div class="rs">
      <h3>Key Takeaways</h3>
      <ul class="tk">
        <li><b>${esc(leader.name)}</b> leads overall visibility at ${pf(leader.vis)}${leader.id !== me.id ? `, ${gap}% ahead of ${esc(me.name)} at ${pf(me.vis)}` : ''}.</li>
        <li><b>${esc(me.name)}</b> ${me.mentions > 0 ? `commands ${pf(me.sov)} market share with ${(me.mentions || 0).toLocaleString()} mentions` : 'is tracked for competitive intelligence'}${me.id === leader.id ? ', leading the field' : ''}.</li>
        <li>${rows.length} brands tracked across ${models.length} AI platforms and ${promptResults.length} prompts.</li>
        ${rows.length > 1 ? `<li>A ${((rows[0].vis - rows[rows.length - 1].vis) * 100).toFixed(1)}% visibility gap separates the top brand from ${esc(rows[rows.length - 1].name)} at ${pf(rows[rows.length - 1].vis)}.</li>` : ''}
        ${me.sent > 0 ? `<li><b>${esc(me.name)}</b> has a reputation score of ${me.sent}/100, indicating ${me.sent >= 60 ? 'positive' : 'neutral'} brand perception across AI platforms.</li>` : ''}
        <li>Lower-visibility brands should target niche prompts where competition is thinner to build topical authority.</li>
      </ul>
    </div>
    <div class="meth">Methodology — Live multi-engine AI Visibility scan across ${models.length} AI platforms (${models.join(', ')}) and ${promptResults.length} prompts. Visibility = % of AI engine responses that mention your brand. Market Share = your mentions / total brand mentions. Reputation scored 0-100 (50 = neutral). Generated on ${new Date().toLocaleDateString()}.</div>
  `;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>AI Visibility Report — ${esc(tN)}</title>
<meta property="og:title" content="AI Visibility Report — ${esc(tN)}">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:#fff;color:#1a1a2e}
.page{background:#fff;color:#1a1a2e;overflow:hidden;width:100%}
.rh{background:linear-gradient(135deg,#1a2e1a,#2d5e2d);padding:20px 36px;color:#fff;position:relative}
.rh .tl{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#fff9;margin-bottom:4px}.rh h1{font-size:24px;font-weight:700;margin-bottom:6px}.rh .dr{font-size:12px;color:#fff7}
.rh .rlogo{position:absolute;top:50%;right:36px;transform:translateY(-50%);height:28px;opacity:.85}
.mr{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:2px solid #eee}.mc{padding:12px 10px;text-align:center;border-right:1px solid #eee}.mc:last-child{border:none}
.mc .v{font-size:22px;font-weight:700;color:#7D963D}.mc .l{font-size:9px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.4px;margin-top:3px}
.rs{padding:14px 36px}.rs h3{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:2px}.rs .ss{font-size:10px;color:#999;margin-bottom:10px}
.co{background:#f0f5e6;border-left:4px solid #7D963D;padding:8px 14px;font-size:11px;color:#555;border-radius:0 7px 7px 0;margin-bottom:10px}.co b{color:#7D963D}
.bt{width:100%;border-collapse:collapse;font-size:12px}.bt th{text-align:left;padding:9px 10px;font-size:9px;font-weight:700;color:#999;text-transform:uppercase;border-bottom:2px solid #eee}
.bt td{padding:9px 10px;border-bottom:1px solid #f2f2f2}.bt tr:last-child td{border:none}.bt .rk{font-weight:700;color:#7D963D;width:28px}.bt .bn{font-weight:600;color:#1a1a2e}.bt .nm{font-family:'Space Mono',monospace;font-size:11px}
.hl{background:#f0f5e6 !important}
.vis-bar{width:50px;height:6px;background:#e8e8ee;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:middle;overflow:hidden;position:relative}
.vis-bar .fill{height:100%;border-radius:3px;background:#7D963D;position:absolute;left:0;top:0}
.sent-bar{width:50px;height:6px;background:#e8e8ee;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:middle;overflow:hidden;position:relative}
.sent-bar .fill{height:100%;border-radius:3px;background:#5a7a2d;position:absolute;left:0;top:0}
.bc{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:20px}.bg{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px}
.bpct{font-size:8px;font-weight:600;color:#555}.bbar{width:28px;border-radius:4px 4px 0 0}
.bl{font-size:9px;color:#666;text-align:center;max-width:65px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}.bl.target{font-weight:700;color:#1a1a2e}
.mb{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}.mi{flex:1;min-width:100px;background:#f8f8fc;padding:7px;border-radius:7px;text-align:center;overflow:hidden}
.mi .mn{font-size:8px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:4px}.mm{height:50px;display:flex;align-items:flex-end;justify-content:center;gap:3px;overflow:hidden}
.mmb{width:11px;border-radius:2px 2px 0 0;max-height:50px}
.model-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font-size:9px;color:#666}.ml-item{display:flex;align-items:center;gap:4px}.ml-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.donut-wrap{display:flex;align-items:center;gap:24px;flex-wrap:wrap;justify-content:center}
.donut-legend{font-size:10px;line-height:1.8}.donut-legend div{display:flex;align-items:center;gap:5px}
.donut-legend span{display:inline-block;width:10px;height:10px;border-radius:2px;flex-shrink:0}
.pt{width:100%;border-collapse:collapse;font-size:11px}.pt th{text-align:left;padding:7px 8px;font-size:8px;font-weight:700;color:#999;text-transform:uppercase;border-bottom:2px solid #eee}
.pt td{padding:7px 8px;border-bottom:1px solid #f2f2f2}.pq{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.leaders-cell{font-size:10px;line-height:1.4;max-width:180px}
ul.tk{list-style:none;padding:0}ul.tk li{padding:7px 0 7px 18px;position:relative;font-size:12px;color:#555;line-height:1.5;border-bottom:1px solid #f2f2f2}
ul.tk li:last-child{border:none}ul.tk li::before{content:'—';position:absolute;left:0;color:#7D963D;font-weight:700}
.meth{padding:14px 36px 20px;font-size:10px;color:#bbb;border-top:1px solid #eee}
</style></head>
<body><div class="page">${reportBody}</div></body></html>`;
}

module.exports = { renderBrandedReportHTML };
