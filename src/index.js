import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const {
  OPENAI_API_KEY,
  OPENAI_PROJECT_ID,
  OPENAI_CHAT_MODEL = 'gpt-4o',
  OPENAI_VISION_MODEL = 'gpt-4o-mini',
  OPENAI_TTS_MODEL = 'tts-1',
  OPENAI_TTS_VOICE = 'alloy',
  NEWS_API_KEY,
  SERVICE_API_KEY,
  PORT = 8080,
} = process.env;

if (!OPENAI_API_KEY) {
  console.warn('[config] OPENAI_API_KEY is not set. Requests will fail.');
}
if (!SERVICE_API_KEY) {
  console.warn('[config] SERVICE_API_KEY is not set. Set it before exposing the service.');
}
if (!NEWS_API_KEY) {
  console.warn('[config] NEWS_API_KEY is not set. /news/headlines will be disabled.');
}

const DEFAULT_SYSTEM_PROMPT =
 'You are ThirdEye Assistant, an accessibility expert helping visually impaired users. You know every ThirdEye feature and give concise, confident, up-to-date guidance. When appropriate, proactively mention advanced tips or best practices.'
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use((req, res, next) => {
  if (!SERVICE_API_KEY) {
    return res.status(500).json({ error: 'Service API key is not configured.' });
  }
  const clientKey = req.header('x-api-key');
  if (!clientKey || clientKey !== SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

function openAiHeaders(contentType = 'application/json') {
  const headers = {
    'Content-Type': contentType,
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };
  if (OPENAI_PROJECT_ID) {
    headers['OpenAI-Project'] = OPENAI_PROJECT_ID;
  }
  return headers;
}

function extractResponseText(payload) {
  const outputs = payload?.output ?? payload?.outputs;
  if (!Array.isArray(outputs)) {
    return null;
  }
  for (const output of outputs) {
    const content = output?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') {
        return part.text.trim();
      }
    }
  }
  return null;
}

async function callOpenAiResponses({ input, model = OPENAI_CHAT_MODEL, maxOutputTokens = 800 }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: openAiHeaders(),
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: 0.6,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI responses error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const message = extractResponseText(data);
  if (!message) {
    throw new Error('OpenAI responses returned no text content.');
  }
  return message;
}

app.post('/chat', async (req, res) => {
  const { prompt, text } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const userContent = [];
  userContent.push({ type: 'input_text', text: prompt.trim() });
  if (text && typeof text === 'string' && text.trim()) {
    userContent.push({ type: 'input_text', text: text.trim() });
  }
  try {
    const reply = await callOpenAiResponses({
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: DEFAULT_SYSTEM_PROMPT }],
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      model: OPENAI_CHAT_MODEL,
    });
    res.json({ message: reply });
  } catch (error) {
    console.error('[chat] error', error);
    res.status(502).json({ error: 'Assistant service failed. Please try again.' });
  }
});

app.post('/vision', async (req, res) => {
  const { image, mime_type: mimeType, prompt } = req.body ?? {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'image (base64) is required.' });
  }
  const cleanedMime =
    typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim() : 'image/jpeg';
  const visionPrompt =
    typeof prompt === 'string' && prompt.trim()
      ? prompt.trim()
      : 'Describe the image for someone who cannot see it. Focus on key details and helpful context.';
  try {
    const reply = await callOpenAiResponses({
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: DEFAULT_SYSTEM_PROMPT }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: visionPrompt },
            {
              type: 'input_image',
              image_url: {
                url: `data:${cleanedMime};base64,${image}`,
              },
            },
          ],
        },
      ],
      model: OPENAI_VISION_MODEL,
    });
    res.json({ message: reply });
  } catch (error) {
    console.error('[vision] error', error);
    res.status(502).json({ error: 'Vision service failed. Please try again.' });
  }
});

app.post('/text', async (req, res) => {
  const { prompt, text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  const summaryPrompt =
    typeof prompt === 'string' && prompt.trim()
      ? prompt.trim()
      : 'Summarize the following content for accessibility, highlighting key actions and insights.';
  try {
    const reply = await callOpenAiResponses({
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: DEFAULT_SYSTEM_PROMPT }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: summaryPrompt },
            { type: 'input_text', text: text.trim() },
          ],
        },
      ],
      model: OPENAI_CHAT_MODEL,
    });
    res.json({ message: reply });
  } catch (error) {
    console.error('[text] error', error);
    res.status(502).json({ error: 'Text summarization failed. Please try again.' });
  }
});

app.post('/audio/speech', async (req, res) => {
  const { input, voice = OPENAI_TTS_VOICE, model = OPENAI_TTS_MODEL } = req.body ?? {};
  if (typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'input text is required.' });
  }
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        ...openAiHeaders('application/json'),
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ model, voice, input: input.trim() }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI TTS error ${response.status}: ${errorText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('[audio] error', error);
    res.status(502).json({ error: 'Text-to-speech failed. Please try again.' });
  }
});

app.get('/news/headlines', async (req, res) => {
  if (!NEWS_API_KEY) {
    return res.status(503).json({ error: 'News service is not configured on this server.' });
  }
  const {
    country = 'us',
    category = 'all',
    lang = 'en',
    max = '30',
    q,
  } = req.query;

  const params = new URLSearchParams({
    country: String(country),
    lang: String(lang),
    max: String(max),
    apikey: NEWS_API_KEY,
  });
  if (typeof category === 'string' && category.toLowerCase() !== 'all') {
    params.set('topic', category.toLowerCase());
  }
  if (typeof q === 'string' && q.trim()) {
    params.set('q', q.trim());
  }

  const endpoint = `https://gnews.io/api/v4/top-headlines?${params.toString()}`;
  try {
    const response = await fetch(endpoint, { method: 'GET' });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GNews error ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[news] error', error);
    res.status(502).json({ error: 'Unable to reach the news service right now.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
  console.log(`ThirdEye backend listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server stopped');
  });
});
