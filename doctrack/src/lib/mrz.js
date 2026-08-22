/**
 * Machine-readable zone parsing.
 *
 * Every passport and most national ID cards carry an MRZ: two or three lines of
 * fixed-width OCR-B at the bottom, printed flat with no holograms or background
 * pattern over them, specifically so a machine can read them. It encodes the
 * document number, nationality, date of birth and — the field this whole app
 * exists for — the expiry date.
 *
 * Reading the decorated side of a passport and ignoring the MRZ is doing the
 * hard version of the job badly. OCR gets the MRZ close to perfectly where it
 * mangles the laid-out text, and every field carries a check digit, so a
 * successful parse can be trusted rather than guessed at.
 *
 * Formats: TD3 (passports, 2x44), TD2 (2x36), TD1 (ID cards, 3x30).
 */

const CHECK_WEIGHTS = [7, 3, 1];

/** '<' is 0, digits are themselves, A-Z are 10-35. */
function charValue(ch) {
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  return 0;
}

export function checkDigit(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i += 1) {
    sum += charValue(field[i]) * CHECK_WEIGHTS[i % 3];
  }
  return sum % 10;
}

/**
 * OCR confuses the same handful of glyphs every time. Which way to correct
 * depends on whether the field is meant to hold digits or letters, so the two
 * fixers are separate and applied per field rather than to the whole line.
 */
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };

/**
 * Glyph confusions grouped by how likely they are, so a correction can be tried
 * in order of how much it assumes. A check digit is one decimal digit, so a
 * wrong correction validates one time in ten — trying the boldest rewrite first
 * would let that coin flip decide a passport number.
 */
const DIGIT_PASSES = [
  { O: '0', Q: '0', D: '0' },
  { O: '0', Q: '0', D: '0', I: '1', S: '5', B: '8', Z: '2' },
  TO_DIGIT,
];
const TO_ALPHA = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B' };

const digits = (s) => s.replace(/[A-Z]/g, (c) => TO_DIGIT[c] ?? c);
const alpha = (s) => s.replace(/[0-9]/g, (c) => TO_ALPHA[c] ?? c);

/** YYMMDD as printed in an MRZ. `future` picks the century for expiry dates. */
function mrzDate(raw, { future }) {
  const value = digits(raw);
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // An expiry is ahead of us and a birth date is behind us, which is enough to
  // place the century without guessing.
  const now = new Date().getFullYear() % 100;
  const century = future ? (yy < now - 10 ? 2100 : 2000) : yy > now ? 1900 : 2000;
  const year = century + yy;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The data-bearing head of a passport/TD2 second line: document number, its
 * check digit, nationality, date of birth, its check, sex, expiry, its check.
 *
 * Matching on this structure rather than on line length is what makes detection
 * survive OCR. The filler '<' is the character Tesseract mangles most — it
 * comes back as a guillemet, a K, or nothing at all — so a 44-character line
 * whose tail is filler can arrive 20 characters short. Everything that matters
 * lives in the first 28 characters, and those are all digits and letters.
 */
const TD3_LINE2 =
  /([A-Z0-9<]{9})([0-9])([A-Z<]{3})([0-9]{6})([0-9])([MFX<])([0-9]{6})([0-9])/;

/** TD1 line 2: birth date, check, sex, expiry, check, nationality. */
const TD1_LINE2 = /^([0-9]{6})([0-9])([MFX<])([0-9]{6})([0-9])([A-Z<]{3})/;

const strip = (line) => line.replace(/[^A-Za-z0-9<]/g, '').toUpperCase();

/**
 * Finds MRZ lines in a page of OCR output. Returns the matched line plus the
 * one above it, which carries the names.
 */
export function findMrzLines(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(strip)
    .filter((line) => line.length >= 12);

  // Work backwards: the MRZ is the last block on the page.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];

    const td1 = TD1_LINE2.exec(line);
    if (td1 && lines[i - 1] && lines[i + 1]) {
      return { format: 'TD1', lines: [lines[i - 1], line, lines[i + 1]], match: td1 };
    }

    const td3 = TD3_LINE2.exec(line);
    // Must start at the very beginning of the line, or the digits of a date
    // printed elsewhere on the page can look like one.
    if (td3 && td3.index === 0 && i > 0) {
      return { format: 'TD3', lines: [lines[i - 1], line], match: td3 };
    }
  }
  return null;
}

const NATIONALITIES = {
  CYP: 'Cypriot', LBN: 'Lebanese', ARE: 'Emirati', GBR: 'British', EGY: 'Egyptian',
  SYR: 'Syrian', JOR: 'Jordanian', IND: 'Indian', PAK: 'Pakistani', PHL: 'Filipino',
  LKA: 'Sri Lankan', NPL: 'Nepali', BGD: 'Bangladeshi', IDN: 'Indonesian', ETH: 'Ethiopian',
  KEN: 'Kenyan', USA: 'American', CAN: 'Canadian', AUS: 'Australian', FRA: 'French',
  DEU: 'German', GRC: 'Greek', ITA: 'Italian', ESP: 'Spanish', NLD: 'Dutch',
  RUS: 'Russian', UKR: 'Ukrainian', ZAF: 'South African', NGA: 'Nigerian', TUR: 'Turkish',
  SAU: 'Saudi', KWT: 'Kuwaiti', QAT: 'Qatari', BHR: 'Bahraini', OMN: 'Omani',
  IRQ: 'Iraqi', IRN: 'Iranian', MAR: 'Moroccan', TUN: 'Tunisian', DZA: 'Algerian',
  SDN: 'Sudanese', SOM: 'Somali', CHN: 'Chinese', JPN: 'Japanese', KOR: 'Korean',
};

/**
 * A name part OCR invented out of filler. Real names do not run the same letter
 * three times, and the '<' padding between and after names is what Tesseract
 * mangles most — "CHARALAMBOUS<<RAOUF<<<<<<" comes back with "KKGGGGGG" wedged
 * in the middle often enough to be worth rejecting outright.
 */
const isFillerNoise = (part) => part.length < 2 || /(.)\1{2,}/.test(part);

/** Turns "CHARALAMBOUS<<RAOUF<ANDREA" into readable given-name-first order. */
function readNames(field) {
  const [surnameRaw = '', givenRaw = ''] = alpha(field).split('<<');
  const clean = (s) =>
    s
      .split('<')
      .filter(Boolean)
      .filter((part) => !isFillerNoise(part))
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ')
      .trim();
  const surname = clean(surnameRaw);
  const given = clean(givenRaw);
  return { surname, given, full: [given, surname].filter(Boolean).join(' ') };
}

/**
 * Parses located MRZ lines. Every returned field carries whether its check
 * digit agreed, so the caller can score a verified expiry date differently from
 * one that came out of a smudged line.
 */
export function parseMrz(found) {
  if (!found) return null;
  const { format, lines } = found;

  let numberField;
  let dobField;
  let dobCheck;
  let expiryField;
  let expiryCheck;
  let numberCheck;
  let country;
  let nationality;
  let names;
  let documentCode;

  const match = found.match;

  if (format === 'TD3') {
    const [first] = lines;
    documentCode = alpha(first.slice(0, 1));
    [, numberField, numberCheck, nationality, dobField, dobCheck, , expiryField, expiryCheck] =
      match;
    nationality = alpha(nationality);

    // The names line reads P<XXX<SURNAME<<GIVEN, but OCR turns the '<' into a
    // guillemet, a letter, or nothing. Rather than trusting fixed offsets, find
    // the country code — which line 2 already gave us, behind a check digit —
    // and read the names from just after it.
    country = nationality;
    const at = first.indexOf(nationality);
    names = readNames(at >= 0 ? first.slice(at + 3) : first.replace(/^[A-Z0-9<]{1,5}/, ''));
  } else {
    const [first, , third] = lines;
    documentCode = alpha(first.slice(0, 1));
    country = alpha(first.replace(/^[A-Z0-9<]{1,2}/, '').slice(0, 3));
    numberField = first.slice(5, 14);
    numberCheck = first.slice(14, 15);
    [, dobField, dobCheck, , expiryField, expiryCheck, nationality] = match;
    nationality = alpha(nationality);
    names = readNames(third);
  }

  const agrees = (field, check) => {
    const expected = digits(check);
    return /^\d$/.test(expected) && checkDigit(field) === Number(expected);
  };

  // OCR reads O for 0 all through the number field, but a passport number can
  // legitimately contain the letter O — so rather than rewriting blindly, offer
  // the check digit a few readings, least presumptuous first, and take the one
  // it accepts.
  const candidates = [
    numberField,
    ...DIGIT_PASSES.map((map) => numberField.replace(/[A-Z]/g, (c) => map[c] ?? c)),
  ];
  const accepted = candidates.find((candidate) => agrees(candidate, numberCheck));
  const numberOk = Boolean(accepted);

  const number = (accepted ?? numberField).replace(/</g, '').trim();
  const expiry = mrzDate(expiryField, { future: true });
  const dob = mrzDate(dobField, { future: false });

  return {
    format,
    isPassport: documentCode === 'P',
    country,
    nationality: NATIONALITIES[nationality] ?? NATIONALITIES[country] ?? null,
    nationalityCode: nationality,
    name: names.full || null,
    number: number || null,
    dateOfBirth: dob,
    expiryDate: expiry,
    checks: {
      number: numberOk,
      dateOfBirth: agrees(dobField, dobCheck),
      expiryDate: agrees(expiryField, expiryCheck),
    },
  };
}

/**
 * Levenshtein distance, capped — only small distances are interesting here and
 * there is no reason to finish counting once a candidate is clearly unrelated.
 */
export function editDistance(a, b, cap = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, current[j]);
    }
    if (best > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Cross-checks each part of an MRZ name against the words printed on the rest
 * of the page.
 *
 * Unlike the number and the dates, the MRZ name field carries no check digit —
 * nothing catches "RAOUF" coming back as "KRAOQUF". But the document prints the
 * same name again in the visual zone, in far larger type, so there are two
 * independent reads of it. Where a printed word is a near match, it wins: it
 * came from the more legible half of the page.
 *
 * Returns the reconciled name and whether every part was corroborated, so an
 * uncorroborated name can be flagged rather than quietly filed.
 */
export function reconcileName(name, pageWords) {
  if (!name) return { name: null, corroborated: false };

  const words = [...new Set((pageWords ?? []).filter((w) => w.length >= 3))];
  let everyPartConfirmed = true;

  const parts = name.split(' ').map((part) => {
    const target = part.toUpperCase();
    if (words.includes(target)) return part;

    // Roughly one error per three characters. Tighter than that and a
    // seven-letter misread like KRAOQUF cannot reach RAOUF, which is two edits
    // away; looser and short names start rewriting each other. The candidates
    // are only words printed on this same document, which keeps the risk low.
    const tolerance = Math.max(1, Math.floor(target.length / 3));
    let best = null;
    let bestDistance = tolerance + 1;
    for (const word of words) {
      const distance = editDistance(target, word, tolerance);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = word;
      }
    }

    if (best) return best.charAt(0) + best.slice(1).toLowerCase();
    everyPartConfirmed = false;
    return part;
  });

  return { name: parts.join(' '), corroborated: everyPartConfirmed };
}

/** Convenience: find and parse in one call. */
export function readMrz(text) {
  return parseMrz(findMrzLines(text));
}
