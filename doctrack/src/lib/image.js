/**
 * Phone cameras hand back 4-12 MP JPEGs. Storing those in IndexedDB and posting
 * them to the API is wasteful in both directions, so every photo is downscaled
 * once, on capture, and that single compressed copy is what gets saved and sent.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;
const OUTPUT_TYPE = 'image/jpeg';

/** Bytes above which the API would start to complain (5 MB base64-decoded). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function prepareImage(file) {
  if (!file) throw new Error('No image selected.');
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.type || 'That file'} is not an image.`);
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not compress the photo.'))),
        OUTPUT_TYPE,
        QUALITY,
      );
    });

    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error('Photo is still too large after compression. Try a tighter crop.');
    }

    return { blob, mediaType: OUTPUT_TYPE, width, height };
  } finally {
    bitmap.close?.();
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.onload = () => {
      const result = String(reader.result);
      // strip the "data:image/jpeg;base64," prefix
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Object URLs leak if you forget to revoke them, so every caller gets the
 * revoker back alongside the URL.
 */
export function previewUrl(blob) {
  if (!blob) return { url: null, revoke: () => {} };
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
