// Email notifications for AI scan submissions.
// Uses Resend (same provider Thrive form-receiver uses, sender leads@send.thriveagency.com).
// No-op if RESEND_API_KEY isn't set so the scan endpoint never breaks on missing config.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_TO = (process.env.SCAN_NOTIFY_TO || 'aaron@thriveagency.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const NOTIFY_FROM = process.env.SCAN_NOTIFY_FROM || 'AI Scanner <leads@send.thriveagency.com>';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function notifyScanSubmitted({ scanId, websiteUrl, brand, ip, ua, referer, origin, gclid, utm }) {
  if (!RESEND_API_KEY) {
    console.log('[email-notify] RESEND_API_KEY missing — skipping notification for scan', scanId);
    return { skipped: true };
  }
  const u = utm || {};
  const tracking = (gclid || u.source || u.medium || u.campaign || u.content || u.term) ? `
    <tr><td colspan="2" style="padding-top:14px;font-weight:bold;color:#7D963D">Ad attribution</td></tr>
    ${gclid    ? `<tr><td style="padding:4px 12px 4px 0">GCLID</td><td><code>${esc(gclid)}</code></td></tr>` : ''}
    ${u.source ? `<tr><td style="padding:4px 12px 4px 0">utm_source</td><td>${esc(u.source)}</td></tr>` : ''}
    ${u.medium ? `<tr><td style="padding:4px 12px 4px 0">utm_medium</td><td>${esc(u.medium)}</td></tr>` : ''}
    ${u.campaign ? `<tr><td style="padding:4px 12px 4px 0">utm_campaign</td><td>${esc(u.campaign)}</td></tr>` : ''}
    ${u.content ? `<tr><td style="padding:4px 12px 4px 0">utm_content</td><td>${esc(u.content)}</td></tr>` : ''}
    ${u.term ? `<tr><td style="padding:4px 12px 4px 0">utm_term</td><td>${esc(u.term)}</td></tr>` : ''}
  ` : `<tr><td colspan="2" style="padding-top:14px;color:#888"><em>No ad attribution (likely organic / direct)</em></td></tr>`;

  const scanUrl = `https://thrive-ai-visibility.onrender.com/report/${scanId}`;
  // PDF gateway: thrive-report-app uses Puppeteer to render the scan report
  // page to a branded PDF on-demand. First click generates + caches; subsequent
  // clicks serve from cache.
  const slug = (websiteUrl || '').replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  const pdfName = `AI_Scan_${slug}_${date}.pdf`;
  const pdfUrl = `https://thrive-report-app.onrender.com/api/url-to-pdf?url=${encodeURIComponent(scanUrl)}&filename=${encodeURIComponent(pdfName)}`;

  const subject = `New AI Scan — ${brand || 'unknown'} (${websiteUrl})`;
  const html = `
    <div style="font-family:'DM Sans',-apple-system,system-ui,sans-serif;max-width:600px;color:#1a1a1a">
      <h2 style="color:#7D963D;margin:0 0 8px;font-size:18px">New AI Scan submitted</h2>
      <p style="margin:0 0 16px;color:#555;font-size:13px">Someone just ran an AI Visibility scan on a Thrive landing page.</p>
      <table style="font-size:13px;border-collapse:collapse;width:100%">
        <tr><td style="padding:4px 12px 4px 0;width:140px;color:#555">Website</td><td><a href="${esc(websiteUrl)}">${esc(websiteUrl)}</a></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Brand (inferred)</td><td>${esc(brand)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Scan ID</td><td><a href="${scanUrl}">#${esc(scanId)} — view report (HTML)</a></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">PDF report</td><td><a href="${pdfUrl}" style="color:#FF6600;font-weight:600">📄 Download branded PDF for MC</a></td></tr>
        <tr><td colspan="2" style="padding-top:14px;font-weight:bold;color:#7D963D">Visitor</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">IP address</td><td><code>${esc(ip)}</code></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">User agent</td><td style="font-size:11px;color:#888">${esc(ua)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Referer</td><td style="font-size:11px;color:#888">${esc(referer) || '<em>none</em>'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Origin (LP)</td><td>${esc(origin)}</td></tr>
        ${tracking}
      </table>
      <p style="margin-top:24px;font-size:11px;color:#aaa">Sent by thrive-ai-visibility · stop these via Render env <code>SCAN_NOTIFY_TO=</code> (empty)</p>
    </div>
  `;
  const text = `New AI Scan
Website: ${websiteUrl}
Brand: ${brand}
Scan ID: ${scanId}  →  ${scanUrl}
PDF for MC: ${pdfUrl}

Visitor:
  IP: ${ip}
  UA: ${ua}
  Referer: ${referer || '(none)'}
  Origin: ${origin}

Ad attribution:
  GCLID: ${gclid || '(none)'}
  utm_source: ${u.source || '(none)'}
  utm_medium: ${u.medium || '(none)'}
  utm_campaign: ${u.campaign || '(none)'}
  utm_content: ${u.content || '(none)'}
  utm_term: ${u.term || '(none)'}
`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: NOTIFY_TO,
        subject,
        html,
        text,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[email-notify] Resend error', resp.status, body);
      return { error: body };
    }
    const data = await resp.json();
    console.log('[email-notify] sent', data.id, 'to', NOTIFY_TO.join(','));
    return { sent: true, id: data.id };
  } catch (err) {
    console.error('[email-notify] network error', err.message);
    return { error: err.message };
  }
}

module.exports = { notifyScanSubmitted };
