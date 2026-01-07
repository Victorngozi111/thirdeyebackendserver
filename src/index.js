import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import OpenAI from 'openai';

const {
  PORT = 8080,
  SERVICE_API_KEY,
  OPENAI_API_KEY,
  OPENAI_PROJECT_ID,
  OPENAI_CHAT_MODEL = 'gpt-4.1-mini',
  OPENAI_VISION_MODEL = 'gpt-4.1',
  OPENAI_AUDIO_MODEL = 'gpt-4o-mini-tts',
  OPENAI_IMAGE_MODEL = 'gpt-image-1', // new
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  project: OPENAI_PROJECT_ID,
});

const app = express();
app.set('trust proxy', 1);

// In-memory daily quota store: { [userId]: { date: 'YYYY-MM-DD', count: number } }
const DAILY_IMAGE_LIMIT = 5;
const imageQuota = new Map();

function todayKeyUtc() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getUserId(req) {
  const headerId = req.header('x-user-id');
  if (headerId && headerId.trim().length > 0) return headerId.trim();
  return req.ip || 'anonymous';
}

function enforceDailyImageQuota(req, res, next) {
  const userId = getUserId(req);
  const today = todayKeyUtc();
  const record = imageQuota.get(userId);
  if (!record || record.date !== today) {
    imageQuota.set(userId, { date: today, count: 0 });
    return next();
  }
  if (record.count >= DAILY_IMAGE_LIMIT) {
    return res
      .status(429)
      .json({ message: 'Daily free image limit reached. Try again tomorrow.' });
  }
  return next();
}

function incrementQuota(req) {
  const userId = getUserId(req);
  const today = todayKeyUtc();
  const record = imageQuota.get(userId);
  if (!record || record.date !== today) {
    imageQuota.set(userId, { date: today, count: 1 });
  } else {
    record.count += 1;
    imageQuota.set(userId, record);
  }
}

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(cors());
app.use(express.json({ limit: '16mb' }));
app.use(morgan('combined'));

const defaultVisionPrompt =
  'Describe the image for a blind user. Give a concise scene summary then list key objects with position and colours. Mention any signs, hazards, or people. Keep it under 180 words.';

function authorize(req, res, next) {
  if (!SERVICE_API_KEY) return next();
  const incoming = req.header('x-api-key');
  if (incoming && incoming.trim() === SERVICE_API_KEY.trim()) return next();
  console.warn('[auth] 401', req.path);
  return res.status(401).json({ message: 'Unauthorized' });
}

function decodeResponseText(response) {
  const output = response?.output_text;
  if (typeof output === 'string' && output.trim().length > 0) {
    return output.trim();
  }
  return null;
}

function buildInputImageContent(image, mimeType = 'image/jpeg') {
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new Error('Missing or invalid image payload');
  }
  const trimmed = image.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { type: 'input_image', image_url: trimmed };
  }
  if (trimmed.startsWith('data:')) {
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex === -1) throw new Error('Malformed data URI image payload');
    const payload = trimmed.substring(commaIndex + 1).trim();
    if (!payload) throw new Error('Empty image payload');
    return { type: 'input_image', image_url: trimmed };
  }
  return { type: 'input_image', image_url: `data:${mimeType};base64,${trimmed}` };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/chat', authorize, async (req, res) => {
  try {
    const { prompt } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ message: 'Request must include a text prompt.' });
    }
    const response = await openai.responses.create({
      model: OPENAI_CHAT_MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt.trim() }] }],
    });
    const message = decodeResponseText(response);
    if (!message) {
      return res.status(502).json({ message: 'Assistant response was empty. Please try again.' });
    }
    return res.json({ message });
  } catch (error) {
    console.error('[chat] error', error);
    return res.status(500).json({ message: 'Assistant service unavailable. Please try again.' });
  }
});

app.post('/vision', authorize, async (req, res) => {
  try {
    const { image, prompt, mime_type: mimeType = 'image/jpeg', model } = req.body ?? {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ message: 'Request must include an image to analyse.' });
    }
    const imageContent = buildInputImageContent(image, mimeType);
    const response = await openai.responses.create({
      model: model || OPENAI_VISION_MODEL,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt?.trim() || defaultVisionPrompt },
            imageContent,
          ],
        },
      ],
    });
    const message = decodeResponseText(response);
    if (!message) {
      return res.status(502).json({ message: 'Vision response was empty. Please try again.' });
    }
    return res.json({ message });
  } catch (error) {
    console.error('[vision] error', error);
    if (error?.response?.status === 400) {
      return res.status(400).json({ message: 'The image data provided was invalid.' });
    }
    return res.status(500).json({ message: 'Vision service unavailable. Please try again.' });
  }
});

app.post('/text', authorize, async (req, res) => {
  try {
    const { text, prompt } = req.body ?? {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ message: 'Request must include text to summarise.' });
    }
    const response = await openai.responses.create({
      model: OPENAI_CHAT_MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                (prompt?.trim() ||
                  'Summarise the following text for accessibility. Highlight key actions, people, and any warnings.') +
                `\n\n${text.trim()}`,
            },
          ],
        },
      ],
    });
    const message = decodeResponseText(response);
    if (!message) {
      return res.status(502).json({ message: 'Summary response was empty. Please try again.' });
    }
    return res.json({ message });
  } catch (error) {
    console.error('[text] error', error);
    return res.status(500).json({ message: 'Text summarisation failed. Please try again.' });
  }
});

app.post('/audio/speech', authorize, async (req, res) => {
  try {
    const { input, voice = 'alloy' } = req.body ?? {};
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ message: 'Request must include text input.' });
    }
    const speech = await openai.audio.speech.create({
      model: OPENAI_AUDIO_MODEL,
      voice,
      input: input.trim(),
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(Buffer.from(await speech.arrayBuffer()));
  } catch (error) {
    console.error('[speech] error', error);
    return res.status(500).json({ message: 'Text-to-speech failed. Please try again.' });
  }
});

// New: image generation with 5/day quota
app.post('/image', authorize, enforceDailyImageQuota, async (req, res) => {
  try {
    const { prompt, size = '1024x1024', quality = 'standard', style = 'vivid' } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ message: 'Request must include an image prompt.' });
    }

    const response = await openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt: prompt.trim(),
      n: 1,
      size,
      quality,
      style,
    });

    const image = response?.data?.[0];
    if (!image?.url) {
      return res.status(502).json({ message: 'Image generation failed. Please try again.' });
    }

    incrementQuota(req);
    return res.json({ url: image.url });
  } catch (error) {
    console.error('[image] error', error);
    if (error?.status === 429) {
      return res
        .status(429)
        .json({ message: 'Upstream image rate limit hit. Please retry shortly.' });
    }
    return res.status(500).json({ message: 'Image generation failed. Please try again.' });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Payload too large. Keep images/text under 16MB.' });
  }
  console.error('[unhandled]', err);
  return res.status(500).json({ message: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`ThirdEye backend listening on port ${PORT}`);
});
