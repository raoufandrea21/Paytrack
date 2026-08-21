import { handleExtract } from './_handler.js';

/**
 * Serverless entry point for a deployed DocTrack (Vercel-style signature).
 * Local development does not use this file — vite.config.js runs the same
 * handler as dev middleware so `npm run dev` needs nothing extra.
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const payload = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const { status, body } = await handleExtract(payload, {
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  res.status(status).json(body);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
