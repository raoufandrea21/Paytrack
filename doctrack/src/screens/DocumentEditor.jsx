import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  db,
  addDocument,
  deleteDocument,
  getSettings,
  renewDocument,
  reviewQueue,
  updateDocument,
} from '../db.js';
import { documentLabel } from '../lib/constants.js';
import { reviewReasonsFor } from '../lib/review.js';
import { currentRun, endRun, positionIn } from '../lib/reviewrun.js';
import { extractDocument, extractionAvailable, ExtractionError } from '../lib/extract.js';
import Screen from '../components/Screen.jsx';
import PhotoInput from '../components/PhotoInput.jsx';
import DocumentForm, { validateDocument } from '../components/DocumentForm.jsx';
import { Banner, Button, Spinner } from '../components/ui.jsx';

const EMPTY = {
  member_id: '',
  type: 'other',
  label: '',
  no_expiry: 0,
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
  // Only needed for the label suggestions, so an empty list is a fine default.
  const knownDocuments = useLiveQuery(() => db.documents.toArray(), [], []);
  // `?? null` for the same reason as on the detail screen: Dexie says undefined
  // for a row that is not there, and useLiveQuery says undefined for "still
  // loading". Without the difference, editing a document deleted on the other
  // device is a spinner that never stops rather than a bounce back home.
  const existing = useLiveQuery(
    async () => (documentId ? (await db.documents.get(documentId)) ?? null : null),
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * Working through the "needs checking" pile, rather than editing one
   * document you went looking for.
   *
   * It is the same form either way — what changes is where Save goes. Landing
   * on the detail page after every single correction, and having to press back
   * and pick the next one out of a list of thirty-eight, is most of the work
   * and none of the point.
   */
  const checking = search.get('queue') === 'review';
  const [queue, setQueue] = useState(null);

  useEffect(() => {
    if (!checking || !documentId) { setQueue(null); return undefined; }
    let alive = true;
    reviewQueue().then(({ ids }) => {
      if (!alive) return;
      const run = currentRun();
      // A run someone deep-linked into, or reopened in a new tab, has no
      // snapshot; fall back to the live list so the screen still works.
      setQueue(positionIn(run, documentId, ids) ?? positionIn(ids, documentId, ids));
    });
    return () => { alive = false; };
  }, [checking, documentId]);

  /** Where to go after this one — the next in the run, or back to the pile. */
  async function goToNext() {
    const { ids } = await reviewQueue();
    const spot = positionIn(currentRun(), documentId, ids);
    const nextId = spot ? spot.nextId : ids.find((id) => id !== documentId) ?? null;
    if (!nextId) endRun();
    navigate(nextId ? `/documents/${nextId}/edit?queue=review` : '/review', { replace: true });
  }

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  /**
   * Moving to the next document to check reuses this component — same route,
   * different id — so everything about the last one has to be dropped. Without
   * this the form would still be showing the previous document's values, and
   * saving would write them over the new one.
   */
  useEffect(() => {
    setSeeded(false);
    setPhoto(null);
    setExtraction(null);
    setStatus('idle');
    setNotice(null);
    setErrors({});
    setConfirmDelete(false);
    setStep(mode === 'edit' ? 'confirm' : 'capture');
  }, [documentId, mode]);

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
    // The live query can still be holding the document we just moved off; only
    // seed from the one actually being edited.
    if (existing.id !== documentId) return;

    setForm({
      member_id: existing.member_id,
      type: existing.type,
      // A renewal is the same document again, so its label carries over.
      label: existing.label ?? '',
      no_expiry: existing.no_expiry ?? 0,
      number: mode === 'renew' ? '' : existing.number ?? '',
      issue_date: mode === 'renew' ? '' : existing.issue_date ?? '',
      expiry_date: mode === 'renew' ? '' : existing.expiry_date ?? '',
      notes: existing.notes ?? '',
    });
    setSeeded(true);
  }, [seeded, members, existing, mode, search, navigate, documentId]);

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
      if (f.label?.value) next.label = f.label.value;
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
    const validation = validateDocument(form, { requireRemindable: checking });
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
        label: form.label.trim(),
        no_expiry: form.no_expiry ? 1 : 0,
        number: form.number.trim(),
        issue_date: form.issue_date || '',
        expiry_date: form.expiry_date || '',
        notes: form.notes.trim(),
        // Any pass through this form counts as the human having looked at it.
        review_needed: 0,
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
        payload.file_kind = photo.kind;
      } else if (mode === 'edit') {
        payload.photo = existing?.photo ?? null;
        payload.photo_type = existing?.photo_type ?? null;
        payload.file_kind = existing?.file_kind ?? null;
      }

      let targetId = documentId;
      if (mode === 'add') {
        targetId = await addDocument(payload);
      } else if (mode === 'renew') {
        targetId = await renewDocument(documentId, payload);
      } else {
        await updateDocument(documentId, payload);
      }

      if (checking) {
        // Straight on to the next one in the run, without a detour through a
        // detail page nobody asked to see.
        await goToNext();
        return;
      }

      navigate(`/documents/${targetId}`, { replace: true });
    } catch (error) {
      setStatus('idle');
      setNotice({ tone: 'error', text: error?.message ?? 'Could not save.' });
    }
  }

  const title = checking
    ? 'Check this one'
    : mode === 'renew'
      ? `Renew ${documentLabel(existing ?? {})}`
      : mode === 'edit'
        ? 'Edit document'
        : 'Add document';

  /** Move on without changing anything — it stays in the pile for later. */
  const skip = goToNext;

  const loading = members === null || (mode !== 'add' && existing === undefined);

  return (
    <Screen
      title={title}
      subtitle={
        checking && queue?.total
          ? `${queue.index} of ${queue.total} · ${queue.remaining} still to do`
          : mode === 'renew'
            ? 'The old record is kept in the archive.'
            : undefined
      }
      back={checking ? '/review' : true}
      footer={
        step === 'confirm' ? (
          checking ? (
            <div className="flex gap-2">
              <Button variant="secondary" className="px-4" onClick={skip} disabled={status === 'saving'}>
                Skip
              </Button>
              <Button onClick={handleSave} disabled={status === 'saving'} className="flex-1">
                {status === 'saving' ? <Spinner /> : null}
                {queue?.nextId ? 'Looks right — next' : 'Looks right — finish'}
              </Button>
            </div>
          ) : (
            <Button onClick={handleSave} disabled={status === 'saving'} className="w-full">
              {status === 'saving' ? <Spinner /> : null}
              {mode === 'renew' ? 'Save renewal' : mode === 'edit' ? 'Save changes' : 'Save document'}
            </Button>
          )
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
          {/* What was wrong with it, at the top, before the form. Being told
              "this needs checking" and then having to work out why is most of
              the reason a pile of thirty-eight never gets cleared. */}
          {checking && existing ? (
            <Banner tone="warn" title="Why this one was flagged">
              <ul className="space-y-0.5">
                {reviewReasonsFor(existing).map((reason, i) => (
                  <li key={i}>• {reason}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

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
              {mode === 'add' ? (
                <p className="text-center text-[13px] text-slate-500 dark:text-slate-400">
                  Got several?{' '}
                  <Link to="/upload" className="font-semibold text-indigo-600 underline underline-offset-2 dark:text-indigo-400">
                    Upload them all at once
                  </Link>
                  .
                </p>
              ) : null}
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
                knownDocuments={knownDocuments}
              />

              {mode === 'edit' ? (
                <div className="pt-4">
                  <Button
                    variant={confirmDelete ? 'danger' : 'secondary'}
                    className="w-full"
                    onClick={async () => {
                      if (!confirmDelete) { setConfirmDelete(true); return; }
                      await deleteDocument(documentId);
                      navigate('/', { replace: true });
                    }}
                  >
                    {confirmDelete
                      ? 'Delete permanently — this cannot be undone'
                      : 'Delete this document'}
                  </Button>
                  {confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="mt-2 min-h-11 w-full text-[14px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              ) : null}
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
