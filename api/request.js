import { getCatalogue } from './_lib/catalogue.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const line = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const LABEL = { cpl: 'CPL3D', n3d: 'N3D' };
const hm = s => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}h ${m % 60}m`; };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.website) return res.status(200).json({ ok: true, ref: 'REQ-OK' }); // honeypot

  const name = line(b.name).slice(0, 100);
  const email = line(b.email).slice(0, 200);
  const notes = String(b.notes ?? '').slice(0, 2000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: 'Please enter your name and a valid email.' });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50)
    return res.status(400).json({ error: 'Add at least one design to your request.' });

  const { items: catalogue } = await getCatalogue();
  const map = new Map(catalogue.map(i => [i.id, i]));
  const lines = b.items
    .map(x => ({ item: map.get(String(x.id)), qty: Math.min(99, Math.max(1, parseInt(x.qty, 10) || 1)) }))
    .filter(x => x.item);
  if (!lines.length) return res.status(400).json({ error: 'Those designs are no longer available. Please refresh.' });

  const ref = 'REQ-' + Date.now().toString(36).toUpperCase();
  const text = [
    ref, `From: ${name} <${email}>`, '',
    ...lines.map(l => `${l.qty} x ${l.item.name} [${LABEL[l.item.source]}]`),
    '', 'Notes:', notes || '(none)',
  ].join('\n');
  const html = `<h2>${esc(ref)}</h2><p><b>${esc(name)}</b> &lt;${esc(email)}&gt;</p><ul>${lines.map(l =>
    `<li>${l.qty} &times; ${esc(l.item.name)} <small>(${LABEL[l.item.source]})</small></li>`).join('')}</ul>
    <p><b>Notes</b><br>${esc(notes || '(none)').replace(/\n/g, '<br>')}</p>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.REQUEST_FROM || 'Print Requests <onboarding@resend.dev>',
        to: [process.env.REQUEST_TO], reply_to: email,
        subject: `${ref}: print request from ${name}`, text, html,
      }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status} ${await r.text()}`);
    res.status(200).json({ ok: true, ref });
  } catch (e) {
    console.error('request email failed:', e.message);
    res.status(502).json({ error: 'Your request couldn’t be sent. Please try again in a moment.' });
  }
}
