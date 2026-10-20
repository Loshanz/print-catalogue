import { getCatalogue } from './_lib/catalogue.js';

export default async function handler(req, res) {
  try {
    const { items, degraded } = await getCatalogue();
    res.setHeader('Cache-Control', degraded
      ? 'public, s-maxage=60'
      : 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ items, degraded });
  } catch {
    res.status(500).json({ error: 'Catalogue unavailable' });
  }
}
