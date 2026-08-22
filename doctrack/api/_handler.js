import Anthropic from '@anthropic-ai/sdk';
import {
  buildExtractionRequest,
  parseExtractionResponse,
} from '../shared/extraction-spec.js';

const MAX_BASE64_LENGTH = 8 * 1024 * 1024; // ~6 MB of image
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * The server half of proxy mode: holds the API key, forwards one image, returns
 * the parsed JSON. Shared verbatim by the Vite dev middleware and the deployed
 * serverless function so the two can't drift.
 *
 * Returns { status, body } rather than touching a response object, because the
 * two callers have completely different response APIs.
 */
export async function handleExtract(payload, { apiKey } = {}) {
  if (!apiKey) {
    return {
      status: 500,
      body: {
        error:
          'ANTHROPIC_API_KEY is not set on the server. Add it to .env.local (local) or the project environment (deployed), or switch Settings to direct mode.',
      },
    };
  }

  const { imageBase64, mediaType } = payload ?? {};
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return { status: 400, body: { error: 'imageBase64 is required.' } };
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return { status: 413, body: { error: 'Image is too large.' } };
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return { status: 400, body: { error: `Unsupported media type: ${mediaType}` } };
  }

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create(
      buildExtractionRequest({ imageBase64, mediaType }),
    );
    return { status: 200, body: parseExtractionResponse(message) };
  } catch (error) {
    const status = error?.status;
    if (status === 401) return { status: 401, body: { error: 'The server API key was rejected.' } };
    if (status === 429) {
      return { status: 429, body: { error: 'Rate limited by the API. Try again shortly.' } };
    }
    console.error('[doctrack] extraction failed', error);
    return {
      status: typeof status === 'number' && status >= 400 ? status : 502,
      body: { error: error?.message ?? 'Extraction failed.' },
    };
  }
}
