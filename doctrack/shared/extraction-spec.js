/**
 * Shared contract for the Claude vision extraction call.
 *
 * Imported by BOTH the browser (src/lib/extract.js, direct-to-Anthropic mode)
 * and the server (api/extract.js + the Vite dev middleware, proxy mode), so the
 * prompt and schema can never drift between the two paths.
 */

export const EXTRACTION_MODEL = 'claude-sonnet-4-6';

export const DOCUMENT_TYPE_IDS = [
  'emirates_id',
  'cyprus_id',
  'driving_license',
  'passport',
  'residency_visa',
  'vehicle_registration',
  'car_insurance',
  'health_insurance',
  'other',
];

/**
 * Every text field is "" when unknown rather than absent or null: an empty
 * string is a request for the human to fill it in, and it keeps the schema to
 * the plainest shapes structured outputs accept. src/lib/extract.js normalises
 * "" back to null before the data reaches the UI.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    document_type: {
      type: 'string',
      enum: [...DOCUMENT_TYPE_IDS, ''],
      description: 'Best match for the kind of document shown. Empty string if unclear.',
    },
    holder_name_guess: {
      type: 'string',
      description:
        'Name of the person the document belongs to, in Latin script if the document shows one. Empty string if only Arabic script is legible or no name is visible.',
    },
    id_number_guess: {
      type: 'string',
      description:
        'The primary identifying number of the document, digits normalised to Western Arabic numerals, punctuation preserved as printed. Empty string if not legible.',
    },
    label_guess: {
      type: 'string',
      description:
        'A short qualifier that tells this document apart from another of the same type for the same person — for a passport the issuing country, for a vehicle document the plate or model. One or two words. Empty string if nothing distinguishing is visible.',
    },
    issue_date: {
      type: 'string',
      description: 'Issue date as YYYY-MM-DD. Empty string if absent or ambiguous.',
    },
    expiry_date: {
      type: 'string',
      description: 'Expiry date as YYYY-MM-DD. Empty string if absent or ambiguous.',
    },
    confidence: {
      type: 'number',
      description: 'Overall confidence in this extraction, 0 to 1.',
    },
    field_confidence: {
      type: 'object',
      description:
        'Per-field confidence, 0 to 1. Anything below 0.7 is flagged for review in the UI.',
      properties: {
        document_type: { type: 'number' },
        holder_name_guess: { type: 'number' },
        id_number_guess: { type: 'number' },
        issue_date: { type: 'number' },
        expiry_date: { type: 'number' },
      },
      required: [
        'document_type',
        'holder_name_guess',
        'id_number_guess',
        'issue_date',
        'expiry_date',
      ],
      additionalProperties: false,
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Short human-readable notes about anything the reader should check by hand: glare, cropped edges, Arabic-only fields, ambiguous date order, Hijri dates.',
    },
  },
  required: [
    'document_type',
    'holder_name_guess',
    'id_number_guess',
    'label_guess',
    'issue_date',
    'expiry_date',
    'confidence',
    'field_confidence',
    'warnings',
  ],
  additionalProperties: false,
};

export const EXTRACTION_SYSTEM_PROMPT = `You read photographs of UAE personal and vehicle documents and return structured data for a family document-expiry tracker.

Documents you will see include Emirates ID cards, Cypriot national identity cards, UAE driving licences, passports (any country), residency visa pages, vehicle registration cards (mulkiya), car insurance certificates, and health insurance cards. Many are bilingual Arabic/English; some are Arabic only, and Cypriot cards are Greek/English.

Take care to distinguish the two identity cards: an Emirates ID says UNITED ARAB EMIRATES and carries a 784-XXXX-XXXXXXX-X number; a Cypriot one says ΚΥΠΡΙΑΚΗ ΔΗΜΟΚΡΑΤΙΑ / REPUBLIC OF CYPRUS. A household can hold both.

Rules:

1. Never guess. If a field is illegible, cropped, glared out, or genuinely absent, return an empty string "" for it and give it a low confidence score. A blank the user fills in by hand is correct behaviour; a plausible-looking wrong value is a missed renewal.

2. Dates. Return YYYY-MM-DD only.
   - Normalise Arabic-Indic (٠١٢٣٤٥٦٧٨٩) and Eastern Arabic-Indic (۰۱۲۳۴۵۶۷۸۹) digits to Western numerals.
   - Greek month names on Cypriot documents are Gregorian; read them normally.
   - UAE documents almost always print dates as DD/MM/YYYY. Use that reading.
   - If the day/month order is genuinely ambiguous (e.g. 03/04/2027 with no other date on the card to disambiguate against), still return your DD/MM reading but drop that field's confidence below 0.6 and add a warning naming the raw string you saw.
   - If a date is Hijri only, return "" for that field and add a warning with the Hijri date as printed. Do not convert it.
   - Two-digit years: expand using the surrounding context (an expiry is in the future, an issue date is in the past).

3. Names. Prefer the Latin-script name printed on the document, exactly as printed. If the document shows the name only in Arabic script, return null and add a warning saying the name is Arabic-only — do not transliterate.

4. Numbers. For an Emirates ID use the 784-XXXX-XXXXXXX-X number. For a Cypriot identity card use the ID/ταυτότητα number printed on the front. For a passport use the passport number. For a driving licence use the licence number. For a vehicle registration use the traffic plate number. For an insurance card use the policy or member number. Keep the punctuation the document prints. Normalise any Arabic-Indic digits.

5. document_type must be one of the allowed enum values, or "" if you cannot tell which it is.

5a. label_guess distinguishes two documents of the same kind belonging to the same person. One household commonly holds two passports per adult, or two cars. For a passport give the issuing country ("Cypriot", "Lebanese"). For a vehicle registration or motor policy give the plate number or model. For anything with nothing to distinguish it, return "".

6. Multi-page PDFs. Read every page. A policy document often prints the expiry as "Period of Insurance: from X to Y" — the later date is the expiry. If several documents appear in one file, describe the primary one and add a warning that the file holds more than one.

7. warnings should be short and actionable, aimed at someone about to file this automatically without looking at it. Return an empty array if the read was clean.

Return only the structured object.`;

export const EXTRACTION_USER_PROMPT =
  'Extract the document fields from this photo. Follow the rules exactly — an empty string over a guess.';

export const PDF_MEDIA_TYPE = 'application/pdf';

export const SUPPORTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  PDF_MEDIA_TYPE,
];

/**
 * The request body shared by every transport (browser SDK, edge function, dev
 * middleware). Photos go in as an `image` block; PDFs — which is how insurance
 * policies and visa pages usually arrive by email — go in as a `document` block.
 */
export function buildExtractionRequest({ imageBase64, mediaType }) {
  const source = { type: 'base64', media_type: mediaType, data: imageBase64 };
  const fileBlock =
    mediaType === PDF_MEDIA_TYPE
      ? { type: 'document', source }
      : { type: 'image', source };

  return {
    model: EXTRACTION_MODEL,
    max_tokens: 2048,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [fileBlock, { type: 'text', text: EXTRACTION_USER_PROMPT }],
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
    },
  };
}

/** Pull the JSON payload out of a Messages API response. */
export function parseExtractionResponse(message) {
  const textBlock = (message?.content ?? []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block to parse.');
  return JSON.parse(textBlock.text);
}
