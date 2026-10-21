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

  // /poke-balls is the documented endpoint that carries the official `pokedex_num` field
  // (e.g. "0149"). /library does not expose it, so fetch it separately and merge by id/slug.
  // If this call fails the catalogue still loads, using the older number guessing below.
  let dex = [];
  try {
    dex = await pages(
      p => `https://www.cpl3d.com/api/v1/poke-balls?limit=100&page=${p}&sort=pokedex_num&sortDir=asc`,
      key, b => b.models || [], b => Number(b.page) * Number(b.limit) < Number(b.total));
  } catch (e) { console.error('poke-balls lookup failed:', e.message); }

  const pad = v => {
    const s = String(v ?? '').trim();
    return /^\d{1,4}$/.test(s) && +s > 0 ? s.padStart(4, '0') : null;
  };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dexById = new Map(), dexBySlug = new Map(), dexByWord = new Map();
  for (const d of dex) {
    const n = pad(d.pokedex_num);
    if (!n) continue;
    dexById.set(d.id, n);
    dexBySlug.set(d.slug, n);
    // Plain single-word Pokémon names ("Dragonite", "Wooper") -> number, used for
    // designs like ponchos or "Ditto Magnemite" that aren't tagged with a number themselves
    const nm = norm(d.name);
    if (nm && !nm.includes(' ') && !dexByWord.has(nm)) dexByWord.set(nm, n);
  }
  const NOISE = new Set(['poncho', 'ponchos', 'pokeball', 'poke', 'ball', 'the', 'and', 'shiny', 'mega']);
  const fromName = name => {
    for (const w of norm(name).split(' ')) {
      if (!NOISE.has(w) && dexByWord.has(w)) return dexByWord.get(w);
    }
    return null;
  };

  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  const leading = s => /^\s*(\d{1,4})(?=[-\s_.])/.exec(s || '')?.[1];
  // Manual overrides for designs that have no number anywhere in the data
  const MANUAL_NUMBERS = {
    // 'Eevee Poncho': '0133',
  };
  // Number from an image filename: at the start, or a standalone 4-digit number like -0025-
  const fromImage = url => {
    const file = decode((url || '').split('?')[0].split('/').pop());
    const any = /(?<![A-Za-z0-9])([01]\d{3})(?![A-Za-z0-9])/.exec(file)?.[1];
    return leading(file) || (any && +any <= 1100 ? any : null);
  };
  const missing = [];
  const withNumber = m => {
    if (/^\s*\d/.test(m.name)) return m.name;
    const num = MANUAL_NUMBERS[m.name]
      || leading(m.slug) || leading(m.print_profiles?.[0]?.name)
      || fromImage(m.thumbnail)
      || dexById.get(m.id) || dexBySlug.get(m.slug)
      || fromName(m.name);
    if (!num) missing.push(m.name);
    return num ? `${num} - ${m.name}` : m.name;
  };
  const items = models.map(m => ({
    id: `cpl-${m.id}`, source: 'cpl', name: withNumber(m), image: m.thumbnail || null,
  }));
  // Shows up in Vercel runtime logs: designs that still sort to the bottom. Add them to MANUAL_NUMBERS.
  if (missing.length) console.warn('CPL designs without a number:', missing.join(' | '));
  return items;
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
