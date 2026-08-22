# DocTrack

A private, local-first PWA for keeping track of when your family's documents
expire — Emirates IDs, driving licences, passports, residency visas, vehicle
registrations, car insurance, health insurance.

Upload a pile of photos or PDFs and walk away. Each one is read, classified,
filed under the right person — creating that person if they are new — and its
reminders set at 60, 30 and 7 days before expiry. No form in between.

**It costs nothing to run.** Reading happens on the device by default: an OCR
engine compiled to WebAssembly, served from the app's own origin, no account and
no API key. Claude is available as a more accurate paid alternative, and neither
is required — every field can be typed by hand.

Everything — records, photos, history — is stored in IndexedDB on the device.
No account, no backend, no sync.

---

## Quick start

```bash
cd doctrack
npm install
npm run dev
```

Open http://localhost:5173. That is the whole setup — the default reader needs
no key and no account.

`npm install` also vendors the OCR engine into `public/tesseract/` (see
`scripts/vendor-ocr.mjs`). It is ~15 MB of build output that never gets
committed, and a browser downloads about 7 MB of it the first time a document is
read, then caches it.

### Optional: reading documents with Claude

More accurate than the on-device reader, handles PDFs and Arabic, and costs
roughly a penny a document.

```bash
cp .env.example .env.local     # then paste your Anthropic API key into it
```

Then switch **Settings → How documents are read** to *Claude, through a server
endpoint*.

`npm run dev` also serves `POST /api/extract`, the endpoint that talks to the
Claude API, so there is nothing else to run alongside Vite.

**Where the API key goes:** `.env.local`, as `ANTHROPIC_API_KEY=sk-ant-...`.
Get one from [console.anthropic.com](https://console.anthropic.com/settings/keys).
The variable has no `VITE_` prefix, so Vite never inlines it into the browser
bundle — it is read only by the dev middleware in `vite.config.js` and by
`api/extract.js` when deployed. (A second, keyless option exists — see
[Auto-fill modes](#auto-fill-modes).)

Without a key the app still works completely; auto-fill just fails with a
message and you type the fields in yourself.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + the `/api/extract` endpoint |
| `npm run dev:https` | Same, over HTTPS on your LAN IP — needed to install on a phone |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Extraction, date-parsing and urgency tests |
| `npm run icons` | Regenerate the PWA icons in `public/icons/` |

---

## Installing it on your phone

The app must be served from a **secure origin** — Chrome will not register a
service worker or offer "Add to Home Screen" over plain `http://` to a LAN IP.
Pick whichever of these suits you:

**Local HTTPS (quickest).**

```bash
npm run dev:https
```

Vite prints a `https://192.168.x.x:5173` address. Open it on the phone, accept
the self-signed certificate warning, then Chrome menu → **Add to Home Screen**.

**A tunnel.** `cloudflared tunnel --url http://localhost:5173` (or ngrok) gives
you a real HTTPS URL that works from anywhere, no certificate warning.

**Deployed.** See below — this is the one to use if you want the app to keep
working when your laptop is off, which for a reminder app you probably do.

Once installed it runs offline: the app shell is precached, and all the data was
local to begin with.

### Turning reminders on

Open **Settings → Turn on reminders** and accept the browser prompt. The check
then runs on every launch and whenever you bring the app back to the foreground.
On Chrome for Android, an installed PWA can also register **periodic background
sync**, which wakes DocTrack roughly twice a day without you opening it; on iOS
and desktop Safari that API does not exist, so opening the app is what triggers
the check. Each document notifies once per milestone — reopening the app does
not re-fire reminders you have already seen.

---

## Deploying

The repository root holds a separate app (PayTrack), so deploy `doctrack/` as
its own project with the project root set to `doctrack`. On Vercel:

1. Root Directory: `doctrack`
2. Framework preset: Vite (build `npm run build`, output `dist`)
3. Environment variable: `ANTHROPIC_API_KEY`

`api/extract.js` is picked up as a serverless function and serves the same
`/api/extract` endpoint the dev server does. Any host that can run one Node
function works the same way; on a purely static host, use direct mode instead.

---

## Reader modes

Settings → *Reading documents* → *How documents are read*:

| Mode | Cost | Where the reading happens |
| --- | --- | --- |
| **On this device** (default) | Free | In the browser, via WebAssembly. No key, no account, works offline, and the photo never leaves the device — not even to be read. |
| **Claude, through a server endpoint** | ~1¢/doc | Key in `.env.local` or your host's env. The browser never sees it. |
| **Claude, straight from this device** | ~1¢/doc | Key in this browser's IndexedDB. For a static host with no server. |
| **Off** | Free | Nowhere. Type the fields in yourself. |

### What the free reader gives up

It recognises printed English. That is enough for UAE and Cypriot documents —
the English side of a bilingual card carries every field — but it means:

- **No PDFs.** Photograph the page instead.
- **No Arabic-script fields.** Which matches the app's rule anyway: leave them
  blank and flag them rather than transliterate.
- **More review.** It is a text recogniser with a parser on top, not a model, so
  more documents land in "Needs checking". Confidence is set deliberately
  pessimistically: a field found next to its printed label clears the bar, a
  field inferred from position does not.

The parser knows what these documents look like. It reads `DD/MM/YYYY` as the
UAE prints it, ignores dates on a *date of birth* line, understands an insurance
certificate's "Period of Insurance: from X to Y", and separates a Cypriot
passport from a Cypriot identity card — both say REPUBLIC OF CYPRUS, so the word
"passport" has to outrank the country.

Direct mode calls `api.anthropic.com` from the page itself, using the SDK's
`dangerouslyAllowBrowser` flag. That is a real trade-off, stated plainly: any
script running on the page can read the key. It is reasonable for a personal
device, and worth pairing with a dedicated key that has a spend limit on it. It
is not something to hand to anyone else.

Either way, the **photo is the only thing that leaves the device**, and only at
the moment you take it. The saved records, the images and the renewal history
stay in IndexedDB.

---

## How automatic filing works

Drop several files into **Upload documents** and each one goes through:

1. **Read** — one call to Claude with the photo or PDF
2. **Classify** — which of the eight document types this is
3. **Identify the holder** — matched against people already on file by exact name
   or a *unique* first name. A confident name that matches nobody creates a new
   family member; an unreadable name on a single-person setup goes to that
   person, and otherwise to a holding record called "Unknown holder"
4. **De-duplicate** — same person, same kind, and the same number *or* the same
   expiry date means it is already on file, so it is skipped
5. **Detect a renewal** — same person, same kind, but running later than the
   copy on file. The old record is archived and linked rather than left beside
   the new one with stale reminders. Only fires when there is exactly one
   candidate; two passports and an unlabelled upload is a question, not an answer
6. **Save** and set the reminders

### The one thing it will not do silently

A document whose **expiry date** could not be read confidently is still saved —
losing an upload would be worse — but flagged, and the dashboard shows a
"needs checking" banner linking to the review queue. Same for an unrecognised
document type, an unidentifiable holder, or a shaky document number.

Everything that reads cleanly never asks you anything. This app exists to get
one date right; a plausible-looking wrong date is the single failure that
matters, so that is the one case where it interrupts.

Files are processed one at a time, not in parallel — eight photos uploading at
once over bad wifi is how you get rate-limited halfway through and lose track of
what saved.

## Where documents live

- **Dashboard** — what needs doing. Grouped by person, sorted by urgency.
- **All documents** — the filing cabinet. Every record, searchable by name,
  number or type, filterable by person and type, with archived ones toggleable.
- **Needs checking** — only what filed itself with a doubt. Empty when scans
  are clean.
- **Archive** — renewed and archived records, kept as history.

## How the extraction works

`shared/extraction-spec.js` holds the prompt and the JSON schema, and is
imported by both the browser and the server so the two can never drift.

One call to `claude-sonnet-4-6` with the file and a JSON-schema structured
output (`output_config.format`). Photos go in as an `image` block; PDFs — how
insurance policies and visa pages usually arrive — as a `document` block, so
multi-page files are read in full. The response:

```json
{
  "document_type": "emirates_id",
  "holder_name_guess": "Fatima Al Mansoori",
  "id_number_guess": "784-1988-1234567-1",
  "issue_date": "2024-03-02",
  "expiry_date": "2027-03-01",
  "confidence": 0.94,
  "field_confidence": { "expiry_date": 0.95, "…": 0 },
  "warnings": []
}
```

Photos are downscaled to a 1600px long edge and re-encoded as JPEG before
upload, so a 12 MP camera shot becomes a few hundred KB. PDFs pass through
untouched — re-encoding would lose the text layer that makes them easy to read.

### Arabic and awkward scans

The rule the prompt enforces, and that the client re-checks: **a blank beats a
guess.** A wrong expiry date is a missed renewal; an empty field is thirty
seconds of typing.

- Arabic-Indic (`٠١٢٣٤٥٦٧٨٩`) and Eastern Arabic-Indic (`۰۱۲۳۴۵۶۷۸۹`) digits are
  normalised — in the prompt, and again in `src/lib/dates.js` as a backstop.
- Dates are read as `DD/MM/YYYY`, the UAE convention. When both halves are ≤ 12
  the reading is genuinely ambiguous, so the field's confidence is forced down
  and a warning names the raw string.
- Hijri-only dates are **not** converted. The field comes back blank with the
  Hijri date quoted in a warning.
- An Arabic-only name is left blank rather than transliterated.
- Gregorian month names in Arabic (`مايو`, `تشرين الأول`, …) do parse.

Anything the model was unsure about — or left blank — is outlined in amber on
the confirm screen with "Check this reading" under it, and clears the moment you
touch the field. Nothing blocks you from saving.

---

## The app itself

### Data model

```
FamilyMember  id · name · relation · auto_created · created_at

Document      id · member_id · type · number · issue_date · expiry_date
              photo (Blob) · photo_type · file_kind (image|pdf) · notes
              status (active|archived) · review_needed · renewed_from
              extraction · created_at · updated_at

reminders     one row per (document, milestone) already notified about
settings      key/value: API mode, key, endpoint
```

`type` is one of `emirates_id`, `cyprus_id`, `driving_license`, `passport`,
`residency_visa`, `vehicle_registration`, `car_insurance`, `health_insurance`,
`other`.

`label` does two jobs. On `other` it *is* the type — a tenancy contract, a trade
licence, whatever the built-in list does not cover, with previously used labels
offered back as suggestions. On any other type it is a qualifier, which is what
makes two passports for one person distinguishable: *Passport · Cypriot* and
*Passport · Lebanese*. The reader fills it from the issuing country where it
can, and it is part of a document's identity for de-duplication and renewal
matching.

Dates are plain `YYYY-MM-DD` strings, never `Date` objects, so nothing shifts by
a day when the device changes timezone.

### Urgency

| Band | Window |
| --- | --- |
| 🔴 Red | Expired, or 7 days or fewer |
| 🟠 Amber | 30 days or fewer |
| 🟡 Yellow | 60 days or fewer |
| 🟢 Green | More than 60 days |

The dashboard sorts documents by urgency inside each family member's card, and
floats the member with the most urgent document to the top.

### Renewing

Renewing does not overwrite anything. The old row is set to `archived` and the
new one points back at it through `renewed_from`, so the document's detail
screen shows its previous versions and the Archive keeps the full history.

### Files

```
doctrack/
├── shared/extraction-spec.js   prompt + JSON schema, shared browser ↔ server
├── api/
│   ├── _handler.js             the extraction call itself
│   └── extract.js              serverless wrapper (dev uses vite.config.js)
├── src/
│   ├── db.js                   Dexie schema and every query
│   ├── lib/
│   │   ├── extract.js          picks a reader; normalises whatever it returns
│   │   ├── localread.js        free on-device OCR + a UAE/Cyprus-aware parser
│   │   ├── autofile.js         holder resolution, de-duplication, review rules
│   │   ├── dates.js            Arabic digits, loose date parsing, urgency
│   │   ├── files.js            photo downscale, PDF passthrough, base64
│   │   ├── reminders.js        the reminder engine (runs on page AND in the SW)
│   │   └── notifications.js    permission, on-load check, background sync
│   ├── screens/                Dashboard, BulkAdd, Library, Review,
│   │                           DocumentEditor, DocumentDetail, MemberForm,
│   │                           Archive, Settings
│   ├── components/             Screen, DocumentForm, PhotoInput, ui primitives
│   └── sw.js                   service worker (precache + periodic sync)
├── scripts/vendor-ocr.mjs      copies the OCR engine into public/ at build time
└── test/
    ├── extraction.test.mjs
    └── autofile.test.mjs
```

---

## Not in this version

By design, and unlikely to change:

- **No TAMM, UAE Pass or ICP integration.** There is no public API for reading a
  private individual's document expiries from any of them.
- **No backend and no cloud sync.** The data is on the device on purpose.
- **No multi-device sync.** One device, one copy.

One consequence worth knowing: clearing this site's browser data — or, on some
platforms, uninstalling the app — deletes everything. DocTrack is a reminder
system, not a place to keep the only copy of anything.
