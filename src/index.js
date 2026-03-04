// 1) Add NEWS_API_KEY in env destructuring
const {
  PORT = 8080,
  SERVICE_API_KEY,
  OPENAI_API_KEY,
  OPENAI_PROJECT_ID,
  OPENAI_CHAT_MODEL = 'gpt-4.1-mini',
  OPENAI_VISION_MODEL = 'gpt-4.1',
  OPENAI_AUDIO_MODEL = 'gpt-4o-mini-tts',
  OPENAI_IMAGE_MODEL = 'gpt-image-1',
  NEWS_API_KEY,
} = process.env;

// 2) Add helpers (near your other helper functions)
const NEWSDATA_BASE_URL = 'https://newsdata.io/api/1/latest';

function normalizeCountry(value) {
  const v = String(value || 'us').trim().toLowerCase();
  return v || 'us';
}
function normalizeLanguage(value) {
  const v = String(value || 'en').trim().toLowerCase();
  return v || 'en';
}
function normalizeCategory(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  return v;
}
function mapNewsDataResults(results, { country, category }) {
  if (!Array.isArray(results)) return [];
  return results
    .map((item, index) => {
      const title = item?.title?.trim() || 'Untitled';
      const link = item?.link?.trim() || item?.url?.trim() || '';
      if (!link) return null;
      return {
        article_id: item?.article_id || `${Date.now()}-${index}`,
        title,
        link,
        description: item?.description || item?.content || '',
        image_url: item?.image_url || item?.image || null,
        source_id: item?.source_id || item?.source || 'Unknown Source',
        pubDate: item?.pubDate || item?.publishedAt || new Date().toISOString(),
        country: [country],
        category: [category || 'general'],
      };
    })
    .filter(Boolean);
}

// 3) Add routes (after /health is fine)
app.get(
  [
    '/news',
    '/news/latest',
    '/news/headlines',
    '/news/top-headlines',
    '/api/news',
    '/api/news/latest',
    '/api/news/headlines',
    '/api/news/top-headlines',
  ],
  authorize,
  async (req, res) => {
    try {
      if (!NEWS_API_KEY) {
        return res.status(500).json({ message: 'Missing NEWS_API_KEY on server.', results: [] });
      }

      const country = normalizeCountry(req.query.country);
      const language = normalizeLanguage(req.query.language);
      const category = normalizeCategory(req.query.category);
      const q = String(req.query.q || '').trim();

      const url = new URL(NEWSDATA_BASE_URL);
      url.searchParams.set('apikey', NEWS_API_KEY);
      url.searchParams.set('country', country);
      url.searchParams.set('language', language);
      if (category) url.searchParams.set('category', category);
      if (q) url.searchParams.set('q', q);

      const upstream = await fetch(url.toString());
      const text = await upstream.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({ message: 'News provider returned invalid JSON.', results: [] });
      }

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          message: data?.message || `News upstream failed (${upstream.status}).`,
          results: [],
        });
      }

      const mapped = mapNewsDataResults(data?.results || [], { country, category });
      return res.json({ status: 'success', totalResults: mapped.length, results: mapped });
    } catch (error) {
      console.error('[news] error', error?.message || error);
      return res.status(500).json({ message: 'News service unavailable right now.', results: [] });
    }
  }
);
