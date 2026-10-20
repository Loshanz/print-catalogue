// Server-side only. Keys come from env vars and never reach the browser.
const TTL = (Number(process.env.CACHE_SECONDS) || 86400) * 1000;
const store = {
  cpl: { at: 0, items: [], error: null },
  n3d: { at: 0, items: [], error: null },
};

async function getJSON(url, key) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(`${r.status} ${msg}`);
  }
  return r.json();
}

async function pages(url, key, pick, hasNext) {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const body = await getJSON(url(p), key);
    out.push(...pick(body));
    if (!hasNext(body)) break;
  }
  return out;
}

// CPL3D: /library = models the key owner can actually print (works without a subscription)
async function loadCpl() {
  const key = process.env.CPL_API_KEY;
  if (!key) return [];
  const models = await pages(
    p => `https://www.cpl3d.com/api/v1/library?limit=100&page=${p}`,
    key, b => b.models, b => b.has_next);
  return models.map(m => ({
    id: `cpl-${m.id}`, source: 'cpl', name: m.name, image: m.thumbnail || null,
    printSeconds: m.estimated_print_time_seconds ?? null,
    weightG: m.total_weight_grams ?? null,
    colours: (m.print_profiles?.[0]?.filamentColors || []).map(c => ({ name: c.name, hex: c.hex })),
  }));
}

// N3D: entitled=true = only designs the key owner can print
async function loadN3d() {
  const key = process.env.N3D_API_KEY;
  if (!key) return [];
  const designs = await pages(
    p => `https://www.n3dmelbourne.com/api/v1/designs?entitled=true&include=details&limit=200&page=${p}`,
    key, b => b.data, b => b.pagination?.has_next);
  return designs.map(d => ({
    id: `n3d-${d.slug}`, source: 'n3d', name: d.title, image: d.image_url || d.sprite_url || null,
    printSeconds: d.print_time_seconds ?? null,
    weightG: d.total_weight_grams ?? null,
    colours: (d.filaments || []).map(f => ({ name: f.color, hex: f.hex_color })),
  }));
}

async function refresh(name, loader) {
  const s = store[name];
  if (Date.now() - s.at < TTL) return;
  try { s.items = await loader(); s.error = null; s.at = Date.now(); }
  catch (e) {
    console.error(`${name} sync failed:`, e.message);
    s.error = e.message;
    s.at = Date.now() - TTL + 60_000; // keep serving last good data, retry in a minute
  }
}

export async function getCatalogue() {
  await Promise.all([refresh('cpl', loadCpl), refresh('n3d', loadN3d)]);
  return {
    items: [...store.cpl.items, ...store.n3d.items],
    degraded: !!(store.cpl.error || store.n3d.error),
  };
}
