/**
 * Reading PDFs on the device.
 *
 * Most documents that arrive by email — an attested certificate, a visa
 * printout, an insurance schedule — are PDFs with a real text layer. That text
 * is the original characters, not a picture of them, so pulling it out is both
 * exact and instant: no OCR, no guessing, no confidence score to worry about.
 *
 * Only when a PDF turns out to be a scan (a photograph wrapped in a PDF, with
 * no text layer) does it need rendering to a canvas and running through OCR
 * like any other photo.
 */

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist').catch((error) => {
        throw new Error('The app updated in the background. Reload the page and try again.', {
          cause: error,
        });
      });
      // Vendored alongside the OCR engine rather than pulled from a CDN — same
      // reasoning: no third party in the path of a private document.
      pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env?.BASE_URL ?? '/'}pdf.worker.min.mjs`;
      return pdfjs;
    })().catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

/** Documents are short; reading past this is wasted work on a phone. */
const MAX_PAGES = 5;

/**
 * Returns the document alongside its loading task. Cleanup lives on the task,
 * not on the document — calling destroy() on the document is a no-op at best
 * and throws at worst, and leaving the task open leaks a worker per file, which
 * a batch upload notices.
 */
async function openDocument(blob) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true });
  return { doc: await loadingTask.promise, loadingTask };
}

/**
 * The text layer, laid out line by line.
 *
 * pdf.js hands back positioned fragments, not lines, and the parser downstream
 * depends on lines — "Expiry Date" and its value have to stay together, or stay
 * apart, the same way they look on the page. Fragments are grouped by their y
 * coordinate to rebuild that.
 */
export async function extractPdfText(blob) {
  const { doc, loadingTask } = await openDocument(blob);
  try {
    const pages = Math.min(doc.numPages, MAX_PAGES);
    const out = [];

    for (let n = 1; n <= pages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const rows = new Map();

      for (const item of content.items) {
        if (!item.str?.trim()) continue;
        // transform[5] is the y offset; round it so fragments that sit on the
        // same visual line land in the same bucket despite sub-pixel drift.
        const y = Math.round(item.transform[5] / 3);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: item.transform[4], text: item.str });
      }

      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // top of the page downwards
        .map(([, fragments]) =>
          fragments.sort((a, b) => a.x - b.x).map((f) => f.text).join(' ').replace(/\s+/g, ' ').trim(),
        )
        .filter(Boolean);

      out.push(...lines);
    }

    return { text: out.join('\n'), pages: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Renders pages to images for OCR, for PDFs that are really scans.
 * Scale 2 puts a typical A4 page around 1200x1700, enough for Tesseract.
 */
export async function renderPdfPages(blob, { pages = 2, scale = 2 } = {}) {
  const { doc, loadingTask } = await openDocument(blob);
  try {
    const count = Math.min(doc.numPages, pages);
    const images = [];

    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      images.push(
        await new Promise((resolve, reject) => {
          canvas.toBlob(
            (out) => (out ? resolve(out) : reject(new Error('Could not render the PDF page.'))),
            'image/png',
          );
        }),
      );
    }

    return images;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Below this many characters a "text layer" is really just a stray watermark or
 * a page number, and the PDF should be treated as a scan.
 */
export const MIN_USEFUL_TEXT = 120;

export function hasUsefulText(text) {
  return String(text ?? '').replace(/\s/g, '').length >= MIN_USEFUL_TEXT;
}
