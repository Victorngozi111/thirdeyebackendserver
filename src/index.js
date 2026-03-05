import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import OpenAI from 'openai';

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 8080);
const SERVICE_API_KEY = (process.env.SERVICE_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_PROJECT_ID = (process.env.OPENAI_PROJECT_ID || '').trim();
const OPENAI_CHAT_MODEL = (process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim();
const OPENAI_VISION_MODEL = (process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini').trim();
const OPENAI_IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1').trim();
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts').trim();
const NEWS_API_KEY = (process.env.NEWS_API_KEY || '').trim();

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      ...(OPENAI_PROJECT_ID ? { project: OPENAI_PROJECT_ID } : {}),
    })
  : null;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(morgan('tiny'));

function requireApiKey(req, res, next) {
  if (!SERVICE_API_KEY) {
    return next();
  }
  const provided = String(req.headers['x-api-key'] || '').trim();
  if (!provided || provided !== SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid x-api-key.' });
  }
  return next();
}

function ensureOpenAiConfigured(res) {
  if (openai) {
    return true;
  }
  res.status(500).json({ error: 'OPENAI_API_KEY is missing on the server.' });
  return false;
}

function extractText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            return part.text;
          }
          if (part.type === 'text' && typeof part.value === 'string') {
            return part.value;
          }
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function normalizeVoice(rawVoice) {
  const allowed = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']);
  const candidate = String(rawVoice || 'alloy').trim().toLowerCase();
  return allowed.has(candidate) ? candidate : 'alloy';
}

function closestImageSize(width, height) {
  const w = Number(width) || 1024;
  const h = Number(height) || 1024;

  if (w >= 1400 && h >= 700) {
    return '1536x1024';
  }
  if (h >= 1400 && w >= 700) {
    return '1024x1536';
  }
  return '1024x1024';
}

function buildNewsUrl({ country, language, category, query }) {
  const url = new URL('https://newsdata.io/api/1/latest');
  url.searchParams.set('apikey', NEWS_API_KEY);
  url.searchParams.set('country', (country || 'us').toLowerCase());
  url.searchParams.set('language', (language || 'en').toLowerCase());

  const normalizedCategory = String(category || '').trim().toLowerCase();
  if (normalizedCategory && normalizedCategory !== 'all') {
    url.searchParams.set('category', normalizedCategory);
  }

  const q = String(query || '').trim();
  if (q) {
    url.searchParams.set('q', q);
  }

  return url;
}

function normalizeNewsPayload(payload, fallbackCountry, fallbackCategory) {
  const list = Array.isArray(payload?.results) ? payload.results : [];

  const normalized = list
    .map((item) => {
      const title = String(item?.title || '').trim();
      const link = String(item?.link || item?.url || '').trim();
      if (!title || !link) {
        return null;
      }

      const source = String(item?.source_id || item?.source || 'Unknown Source').trim();
      let country = (fallbackCountry || 'us').toLowerCase();
      if (Array.isArray(item?.country) && item.country.length > 0) {
        country = String(item.country[0] || country).toLowerCase();
      } else if (typeof item?.country === 'string' && item.country.trim()) {
        country = item.country.trim().toLowerCase();
      }

      let category = (fallbackCategory || 'general').toLowerCase();
      if (Array.isArray(item?.category) && item.category.length > 0) {
        category = String(item.category[0] || category).toLowerCase();
      } else if (typeof item?.category === 'string' && item.category.trim()) {
        category = item.category.trim().toLowerCase();
      }

      return {
        article_id: item?.article_id || link,
        title,
        description: String(item?.description || item?.content || '').trim(),
        link,
        url: link,
        image_url: String(item?.image_url || item?.imageUrl || '').trim() || null,
        source_id: source,
        source,
        pubDate: String(item?.pubDate || item?.publishedAt || '').trim() || null,
        country,
        category,
      };
    })
    .filter(Boolean);

  return {
    status: 'success',
    source: 'newsdata',
    totalResults: normalized.length,
    results: normalized,
    articles: normalized,
    data: normalized,
  };
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'thirdeye-backend',
    hasServiceKey: Boolean(SERVICE_API_KEY),
    hasOpenAi: Boolean(OPENAI_API_KEY),
    hasNewsApiKey: Boolean(NEWS_API_KEY),
  });
});

app.post(['/chat', '/api/chat'], requireApiKey, async (req, res) => {
  if (!ensureOpenAiConfigured(res)) {
    return;
  }

  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    const message = extractText(completion?.choices?.[0]?.message?.content);
    if (!message) {
      return res.status(502).json({ error: 'Empty response from model.' });
    }

    return res.json({ message });
  } catch (error) {
    console.error('POST /chat failed:', error);
    return res.status(500).json({ error: 'Chat request failed.' });
  }
});

app.post(['/text', '/api/text'], requireApiKey, async (req, res) => {
  if (!ensureOpenAiConfigured(res)) {
    return;
  }

  const instruction = String(req.body?.prompt || '').trim();
  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const finalPrompt = instruction
    ? `${instruction}\n\nContent:\n${text}`
    : `Summarize this for accessibility users in short clear points:\n\n${text}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      temperature: 0.2,
      messages: [{ role: 'user', content: finalPrompt }],
    });

    const message = extractText(completion?.choices?.[0]?.message?.content);
    if (!message) {
      return res.status(502).json({ error: 'Empty response from model.' });
    }

    return res.json({ message });
  } catch (error) {
    console.error('POST /text failed:', error);
    return res.status(500).json({ error: 'Text summary failed.' });
  }
});

app.post(['/vision', '/api/vision'], requireApiKey, async (req, res) => {
  if (!ensureOpenAiConfigured(res)) {
    return;
  }

  const image = String(req.body?.image || '').trim();
  const prompt = String(
    req.body?.prompt ||
      'Describe the image for someone who cannot see it. Focus on key details and useful context.'
  ).trim();

  if (!image) {
    return res.status(400).json({ error: 'image is required.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      max_tokens: 500,
    });

    const message = extractText(completion?.choices?.[0]?.message?.content);
    if (!message) {
      return res.status(502).json({ error: 'Empty response from model.' });
    }

    return res.json({ message });
  } catch (error) {
    console.error('POST /vision failed:', error);
    return res.status(500).json({ error: 'Vision request failed.' });
  }
});

app.post(['/image', '/api/image'], requireApiKey, async (req, res) => {
  if (!ensureOpenAiConfigured(res)) {
    return;
  }

  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required.' });
  }

  try {
    const size = closestImageSize(req.body?.width, req.body?.height);
    const result = await openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
    });

    const item = result?.data?.[0];
    if (!item) {
      return res.status(502).json({ error: 'Image generation returned no data.' });
    }

    if (item.b64_json) {
      return res.json({ b64_json: item.b64_json });
    }

    if (item.url) {
      return res.json({ image_url: item.url });
    }

    return res.status(502).json({ error: 'Unsupported image response format.' });
  } catch (error) {
    console.error('POST /image failed:', error);
    return res.status(500).json({ error: 'Image generation failed.' });
  }
});

app.post(['/audio/speech', '/api/audio/speech'], requireApiKey, async (req, res) => {
  if (!ensureOpenAiConfigured(res)) {
    return;
  }

  const input = String(req.body?.input || '').trim();
  const voice = normalizeVoice(req.body?.voice);
  if (!input) {
    return res.status(400).json({ error: 'input is required.' });
  }

  try {
    const audio = await openai.audio.speech.create({
      model: OPENAI_TTS_MODEL,
      voice,
      input,
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await audio.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (error) {
    console.error('POST /audio/speech failed:', error);
    return res.status(500).json({ error: 'Text-to-speech failed.' });
  }
});

const newsPaths = [
  '/news',
  '/news/latest',
  '/news/headlines',
  '/news/top-headlines',
  '/api/news',
  '/api/news/latest',
  '/api/news/headlines',
  '/api/news/top-headlines',
];

app.get(newsPaths, requireApiKey, async (req, res) => {
  if (!NEWS_API_KEY) {
    return res.status(500).json({
      error: 'NEWS_API_KEY is missing on the server.',
      message: 'Set NEWS_API_KEY in your backend environment.',
    });
  }

  const country = String(req.query?.country || 'us').trim().toLowerCase();
  const language = String(req.query?.language || 'en').trim().toLowerCase();
  const category = String(req.query?.category || 'general').trim().toLowerCase();
  const query = String(req.query?.q || req.query?.query || '').trim();

  try {
    const url = buildNewsUrl({ country, language, category, query });
    const upstream = await fetchJson(url, 20000);

    if (!upstream.ok) {
      const upstreamMessage =
        upstream?.body?.message || upstream?.body?.error || 'News provider error.';
      return res.status(upstream.status || 502).json({
        error: 'News request failed.',
        message: String(upstreamMessage),
      });
    }

    const normalized = normalizeNewsPayload(upstream.body, country, category);
    return res.json(normalized);
  } catch (error) {
    console.error('GET /news failed:', error);
    return res.status(500).json({
      error: 'Unable to fetch news right now.',
      message: 'Please try again shortly.',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.',
    path: req.originalUrl,
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  if (res.headersSent) {
    return next(error);
  }
  return res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`ThirdEye backend running on port ${PORT}`);
});
