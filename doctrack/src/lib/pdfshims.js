/**
 * Two proposal methods pdf.js 6 uses that no shipping browser has yet.
 *
 * Without them nothing renders: Map.prototype.getOrInsertComputed throws on the
 * main thread the moment a page is drawn, and Math.sumPrecise throws inside the
 * worker while glyphs are being positioned. That is not only a preview problem
 * — rendering is also how a scanned PDF becomes pictures for OCR, so a PDF that
 * is really a photograph could not be read at all.
 *
 * Kept as its own file with no imports, because it has to run in two places:
 * imported by lib/pdf.js on the main thread, and pasted onto the front of the
 * vendored worker by scripts/vendor-ocr.mjs, which cannot import anything.
 *
 * Every one is guarded, so they all become no-ops the day the browser ships
 * them.
 */
export function installPdfShims(scope = globalThis) {
  const MapCtor = scope.Map;
  if (typeof MapCtor === 'function') {
    if (typeof MapCtor.prototype.getOrInsertComputed !== 'function') {
      Object.defineProperty(MapCtor.prototype, 'getOrInsertComputed', {
        value: function getOrInsertComputed(key, callback) {
          if (!this.has(key)) this.set(key, callback(key));
          return this.get(key);
        },
        writable: true,
        configurable: true,
      });
    }
    if (typeof MapCtor.prototype.getOrInsert !== 'function') {
      Object.defineProperty(MapCtor.prototype, 'getOrInsert', {
        value: function getOrInsert(key, value) {
          if (!this.has(key)) this.set(key, value);
          return this.get(key);
        },
        writable: true,
        configurable: true,
      });
    }
  }

  // Adds up glyph advance widths. Neumaier compensation rather than the exact
  // algorithm the proposal specifies: it removes the error that matters here,
  // in a few lines rather than a few hundred.
  if (typeof scope.Math?.sumPrecise !== 'function') {
    Object.defineProperty(scope.Math, 'sumPrecise', {
      value: function sumPrecise(items) {
        let sum = 0;
        let compensation = 0;
        let sawNaN = false;
        let sawPositiveInfinity = false;
        let sawNegativeInfinity = false;

        for (const item of items) {
          if (typeof item !== 'number') {
            throw new TypeError('Math.sumPrecise takes an iterable of numbers');
          }
          if (Number.isNaN(item)) { sawNaN = true; continue; }
          if (item === Infinity) { sawPositiveInfinity = true; continue; }
          if (item === -Infinity) { sawNegativeInfinity = true; continue; }

          const next = sum + item;
          compensation +=
            Math.abs(sum) >= Math.abs(item) ? sum - next + item : item - next + sum;
          sum = next;
        }

        // Both directions at once has no answer — and they have to be tracked
        // as two flags, not one running count, or +∞ and −∞ cancel out and the
        // finite part is returned as if the infinities were never there.
        if (sawNaN || (sawPositiveInfinity && sawNegativeInfinity)) return NaN;
        if (sawPositiveInfinity) return Infinity;
        if (sawNegativeInfinity) return -Infinity;
        const total = sum + compensation;
        // The proposal returns -0 for an empty list, and this keeps that.
        return total === 0 ? -0 : total;
      },
      writable: true,
      configurable: true,
    });
  }
}
