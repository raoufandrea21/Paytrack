/**
 * Turning whatever the user picked into something the API and IndexedDB can
 * both hold.
 *
 * Photos get downscaled and re-encoded once, on capture — a 12 MP camera shot
 * becomes a few hundred KB. PDFs pass through untouched: re-encoding them would
 * lose the text layer that makes them easy to read in the first place.
 */
import { PDF_MEDIA_TYPE, SUPPORTED_MEDIA_TYPES } from '../../shared/extraction-spec.js';

const MAX_EDGE = 1600;
const QUALITY = 0.82;
const IMAGE_OUTPUT_TYPE = 'image/jpeg';

/** Roughly the API's per-request ceiling once base64 expansion is accounted for. */
export const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

/**
 * A PDF only has to fit in IndexedDB when it is read on the device, so the
 * ceiling here is about storage and memory rather than an upload limit. The API
 * path checks MAX_UPLOAD_BYTES separately, at the point it actually matters.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export { PDF_MEDIA_TYPE };

export const ACCEPT_ATTRIBUTE = 'image/*,application/pdf';

export function isPdf(file) {
  return file?.type === PDF_MEDIA_TYPE;
}

/**
 * Returns { blob, mediaType, kind, width, height } ready to store and send.
 * Throws with a message meant for the person who picked the file.
 */
export async function prepareFile(file) {
  if (!file) throw new Error('No file selected.');

  if (isPdf(file)) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error('That PDF is enormous — over 25 MB. Try exporting just the pages you need.');
    }
    return {
      blob: file, mediaType: PDF_MEDIA_TYPE, kind: 'pdf',
      width: null, height: null, source: file,
    };
  }

  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.type || 'That file'} is not an image or a PDF.`);
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not compress the photo.'))),
        IMAGE_OUTPUT_TYPE,
        QUALITY,
      );
    });

    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error('Photo is still too large after compression. Try a tighter crop.');
    }

    // The original is kept for the on-device reader: it works from a larger
    // render than the copy we store, because an MRZ line is 44 characters wide
    // and loses legibility fast as the image shrinks.
    return { blob, mediaType: IMAGE_OUTPUT_TYPE, kind: 'image', width, height, source: file };
  } finally {
    bitmap.close?.();
  }
}

export function mediaTypeSupported(mediaType) {
  return SUPPORTED_MEDIA_TYPES.includes(mediaType);
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1)); // drop the data: prefix
    };
    reader.readAsDataURL(blob);
  });
}

/** Object URLs leak unless revoked, so callers always get the revoker back. */
export function previewUrl(blob) {
  if (!blob) return { url: null, revoke: () => {} };
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
