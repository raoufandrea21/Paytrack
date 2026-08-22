# DocTrack

A private, local-first PWA for keeping track of when your family's documents
expire — Emirates IDs, driving licences, passports, residency visas, vehicle
registrations, car insurance, health insurance.

Photograph a document, Claude reads the fields off it, you confirm, and DocTrack
reminds you at 60, 30 and 7 days before it runs out. Everything — records,
photos, history — is stored in IndexedDB on the device. No account, no backend,
no sync.

---

## Quick start

```bash
cd doctrack
npm install
cp .env.example .env.local     # then paste your Anthropic API key into it
npm run dev
```

Open http://localhost:5173.

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

## Auto-fill modes

Settings → *Auto-fill from photos* → *How to reach the API*:

| Mode | The key lives | Use it when |
| --- | --- | --- |
| **Through a server endpoint** (default) | In `.env.local` / your host's env, server-side | Normal use. The browser never sees the key. |
| **Straight from this device** | In this browser's IndexedDB, entered in Settings | You want no server at all — a static host, or the app installed on one phone you control. |
| **Off** | Nowhere | You would rather type the fields in. |

Direct mode calls `api.anthropic.com` from the page itself, using the SDK's
`dangerouslyAllowBrowser` flag. That is a real trade-off, stated plainly: any
script running on the page can read the key. It is reasonable for a personal
device, and worth pairing with a dedicated key that has a spend limit on it. It
is not something to hand to anyone else.

Either way, the **photo is the only thing that leaves the device**, and only at
the moment you take it. The saved records, the images and the renewal history
stay in IndexedDB.

---

## How the extraction works

`shared/extraction-spec.js` holds the prompt and the JSON schema, and is
imported by both the browser and the server so the two can never drift.

One call to `claude-sonnet-4-6` with the photo and a JSON-schema structured
output (`output_config.format`), returning:

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
upload, so a 12 MP camera shot becomes a few hundred KB.

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
FamilyMember  id · name · relation · created_at

Document      id · member_id · type · number · issue_date · expiry_date
              photo (Blob) · photo_type · notes · status (active|archived)
              renewed_from · extraction · created_at · updated_at

reminders     one row per (document, milestone) already notified about
settings      key/value: API mode, key, endpoint
```

`type` is one of `emirates_id`, `driving_license`, `passport`,
`residency_visa`, `vehicle_registration`, `car_insurance`,
`health_insurance`, `other`.

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
│   │   ├── extract.js          proxy / direct transports, response normalising
│   │   ├── dates.js            Arabic digits, loose date parsing, urgency
│   │   ├── image.js            downscale + JPEG re-encode + base64
│   │   ├── reminders.js        the reminder engine (runs on page AND in the SW)
│   │   └── notifications.js    permission, on-load check, background sync
│   ├── screens/                Dashboard, DocumentEditor, DocumentDetail,
│   │                           MemberForm, Archive, Settings
│   ├── components/             Screen, DocumentForm, PhotoInput, ui primitives
│   └── sw.js                   service worker (precache + periodic sync)
└── test/extraction.test.mjs
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
