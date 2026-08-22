import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { db, addDocument, getSettings, renewDocument, updateDocument } from '../db.js';
import { documentType } from '../lib/constants.js';
import { extractDocument, extractionAvailable, ExtractionError } from '../lib/extract.js';
import Screen from '../components/Screen.jsx';
import PhotoInput from '../components/PhotoInput.jsx';
import DocumentForm, { validateDocument } from '../components/DocumentForm.jsx';
import { Banner, Button, Spinner } from '../components/ui.jsx';

const EMPTY = {
  member_id: '',
  type: 'other',
  number: '',
  issue_date: '',
  expiry_date: '',
  notes: '',
};

/**
 * Add, edit and renew are the same two steps — photograph, then confirm — so
 * they are one screen with a mode, rather than three near-copies.
 *
 * The fast path is three taps: "Add document" → "Take photo" (the camera's own
 * shutter is the system's, not ours) → "Save". Extraction fires automatically
 * the moment the photo is ready, so the confirm screen is already filled in by
 * the time the user looks at it.
 */
export default function DocumentEditor({ mode }) {
  const navigate = useNavigate();
  const params = useParams();
  const [search] = useSearchParams();
  const documentId = params.id ? Number(params.id) : null;

  const members = useLiveQuery(() => db.members.orderBy('created_at').toArray(), [], null);
  const existing = useLiveQuery(
    () => (documentId ? db.documents.get(documentId) : null),
    [documentId],
    undefined,
  );
  const [settings, setSettings] = useState(null);

  const [step, setStep] = useState(mode === 'edit' ? 'confirm' : 'capture');
  const [photo, setPhoto] = useState(null); // { blob, mediaType }
  const [form, setForm] = useState(EMPTY);
  const [extraction, setExtraction] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | extracting | saving
  const [notice, setNotice] = useState(null); // { tone, text }
  const [errors, setErrors] = useState({});
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  // Seed the form once the record and member list have loaded.
  useEffect(() => {
    if (seeded || !members) return;

    if (mode === 'add') {
      const requested = Number(search.get('member'));
      const preset = members.find((m) => m.id === requested) ?? (members.length === 1 ? members[0] : null);
      setForm({ ...EMPTY, member_id: preset?.id ?? '' });
      setSeeded(true);
      return;
    }

    if (existing === undefined) return; // still loading
    if (existing === null) {
      navigate('/', { replace: true });
      return;
    }

    setForm({
      member_id: existing.member_id,
      type: existing.type,
      number: mode === 'renew' ? '' : existing.number ?? '',
      issue_date: mode === 'renew' ? '' : existing.issue_date ?? '',
      expiry_date: mode === 'renew' ? '' : existing.expiry_date ?? '',
      notes: existing.notes ?? '',
    });
    setSeeded(true);
  }, [seeded, members, existing, mode, search, navigate]);

  const canExtract = settings ? extractionAvailable(settings) : false;

  async function handlePhoto(prepared) {
    setPhoto(prepared);
    setNotice(null);

    if (!canExtract) {
      setStep('confirm');
      setNotice({
        tone: 'info',
        text: 'Auto-fill is off, so the fields are blank — type them in below.',
      });
      return;
    }
    await runExtraction(prepared);
  }

  async function runExtraction(prepared) {
    setStatus('extracting');
    setStep('extracting');
    try {
      const result = await extractDocument(prepared.blob, settings ?? {});
      setExtraction(result);
      applyExtraction(result);
      setStep('confirm');
      setNotice(null); // DocumentForm's own banner reports what needs review.
    } catch (error) {
      setStep('confirm');
      setNotice({
        tone: 'error',
        text:
          error instanceof ExtractionError
            ? `${error.message}${error.retryable ? ' You can retry from the photo above.' : ''} Fill the fields in by hand for now.`
            : 'Auto-fill failed. Fill the fields in by hand.',
      });
    } finally {
      setStatus('idle');
    }
  }

  function applyExtraction(result) {
    setForm((prev) => {
      const next = { ...prev };
      const f = result.fields;
      if (f.type.value) next.type = f.type.value;
      if (f.number.value) next.number = f.number.value;
      if (f.issue_date.value) next.issue_date = f.issue_date.value;
      if (f.expiry_date.value) next.expiry_date = f.expiry_date.value;

      // Only guess the member when the name is an unambiguous match, and never
      // overwrite a member the user already chose.
      if (!next.member_id && f.holder_name.value && members) {
        const match = matchMember(f.holder_name.value, members);
        if (match) next.member_id = match.id;
      }
      return next;
    });
  }

  async function handleSave() {
    const validation = validateDocument(form);
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      setNotice({ tone: 'error', text: 'Some fields still need fixing.' });
      return;
    }

    setStatus('saving');
    try {
      const payload = {
        member_id: Number(form.member_id),
        type: form.type,
        number: form.number.trim(),
        issue_date: form.issue_date || '',
        expiry_date: form.expiry_date || '',
        notes: form.notes.trim(),
        extraction: extraction
          ? {
              confidence: extraction.confidence,
              model: extraction.model,
              extracted_at: extraction.extracted_at,
              warnings: extraction.warnings,
              needsReview: extraction.needsReview,
            }
          : (mode === 'edit' ? existing?.extraction ?? null : null),
      };

      if (photo) {
        payload.photo = photo.blob;
        payload.photo_type = photo.mediaType;
      } else if (mode === 'edit') {
        payload.photo = existing?.photo ?? null;
        payload.photo_type = existing?.photo_type ?? null;
      }

      let targetId = documentId;
      if (mode === 'add') {
        targetId = await addDocument(payload);
      } else if (mode === 'renew') {
        targetId = await renewDocument(documentId, payload);
      } else {
        await updateDocument(documentId, payload);
      }

      navigate(`/documents/${targetId}`, { replace: true });
    } catch (error) {
      setStatus('idle');
      setNotice({ tone: 'error', text: error?.message ?? 'Could not save.' });
    }
  }

  const title =
    mode === 'renew'
      ? `Renew ${documentType(existing?.type).label}`
      : mode === 'edit'
        ? 'Edit document'
        : 'Add document';

  const loading = members === null || (mode !== 'add' && existing === undefined);

  return (
    <Screen
      title={title}
      subtitle={mode === 'renew' ? 'The old record is kept in the archive.' : undefined}
      back
      footer={
        step === 'confirm' ? (
          <Button onClick={handleSave} disabled={status === 'saving'} className="w-full">
            {status === 'saving' ? <Spinner /> : null}
            {mode === 'renew' ? 'Save renewal' : mode === 'edit' ? 'Save changes' : 'Save document'}
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner className="size-7" />
        </div>
      ) : members.length === 0 ? (
        <Banner tone="warn" title="No family members yet">
          <p className="mb-3">A document has to belong to someone.</p>
          <Button as="link" to="/members/new">Add a family member</Button>
        </Banner>
      ) : (
        <div className="space-y-4 pb-4">
          <PhotoInput
            blob={photo?.blob ?? (mode === 'edit' ? existing?.photo : null)}
            onChange={handlePhoto}
            onError={(text) => setNotice({ tone: 'error', text })}
            busy={status === 'extracting'}
            label={mode === 'renew' ? 'Photograph the new document' : 'Take photo'}
          />

          {step === 'capture' ? (
            <>
              {canExtract ? (
                <p className="text-center text-[13px] text-slate-500 dark:text-slate-400">
                  The photo is read automatically — you just confirm what it found.
                </p>
              ) : (
                <Banner tone="info">
                  Auto-fill is off. Turn it on in Settings, or just fill the form in yourself.
                </Banner>
              )}
              <Button variant="ghost" onClick={() => setStep('confirm')} className="w-full">
                Skip the photo, enter manually
              </Button>
            </>
          ) : null}

          {step === 'extracting' ? (
            <div className="flex flex-col items-center gap-3 py-10 text-slate-500 dark:text-slate-400">
              <Spinner className="size-7" />
              <p className="text-[15px] font-semibold">Reading the document…</p>
              <button
                type="button"
                onClick={() => setStep('confirm')}
                className="text-[14px] underline underline-offset-4"
              >
                Fill it in myself instead
              </button>
            </div>
          ) : null}

          {step === 'confirm' ? (
            <>
              {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
              {photo && canExtract && status === 'idle' ? (
                <Button variant="secondary" onClick={() => runExtraction(photo)} className="w-full">
                  <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 0115.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 01-15.5 6.2L3 16M3 21v-5h5" />
                  </svg>
                  Read the photo again
                </Button>
              ) : null}
              <DocumentForm
                value={form}
                onChange={setForm}
                members={members}
                extraction={extraction}
                errors={errors}
                lockMember={mode === 'renew'}
              />
            </>
          ) : null}
        </div>
      )}
    </Screen>
  );
}

/**
 * Matches an extracted name to a saved member. Deliberately strict: an exact
 * normalised match, or a unique first-name match. Anything looser risks filing
 * a document under the wrong person, which is worse than asking.
 */
function matchMember(name, members) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z؀-ۿ\s]/g, '').replace(/\s+/g, ' ').trim();
  const target = norm(name);
  if (!target) return null;

  const exact = members.filter((m) => norm(m.name) === target);
  if (exact.length === 1) return exact[0];

  const first = target.split(' ')[0];
  const byFirst = members.filter((m) => norm(m.name).split(' ')[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}
