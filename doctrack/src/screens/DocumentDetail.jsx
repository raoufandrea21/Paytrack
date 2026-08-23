import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  archiveDocument,
  db,
  deleteDocument,
  renewalHistory,
  unarchiveDocument,
} from '../db.js';
import { documentLabel, documentType } from '../lib/constants.js';
import { expiryPhraseFor, formatDate, urgencyForDocument } from '../lib/dates.js';
import { previewUrl } from '../lib/files.js';
import FilePreview, { FullScreenPreview } from '../components/FilePreview.jsx';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Card, Spinner, UrgencyChip } from '../components/ui.jsx';

export default function DocumentDetail() {
  const { id } = useParams();
  const documentId = Number(id);
  const navigate = useNavigate();

  const doc = useLiveQuery(() => db.documents.get(documentId), [documentId], undefined);
  const member = useLiveQuery(
    () => (doc ? db.members.get(doc.member_id) : null),
    [doc?.member_id],
    null,
  );
  const history = useLiveQuery(() => renewalHistory(documentId), [documentId], []);

  const [photoUrl, setPhotoUrl] = useState(null);
  const [backUrl, setBackUrl] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [full, setFull] = useState(null); // the blob being looked at properly

  useEffect(() => {
    const { url, revoke } = previewUrl(doc?.photo);
    setPhotoUrl(url);
    return revoke;
  }, [doc?.photo]);

  useEffect(() => {
    const { url, revoke } = previewUrl(doc?.photo_back);
    setBackUrl(url);
    return revoke;
  }, [doc?.photo_back]);

  if (doc === undefined) {
    return (
      <Screen title="Document" back="/">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  if (doc === null) {
    return (
      <Screen title="Document" back="/">
        <Banner tone="warn" title="Not found">
          <p className="mb-3">This document has been deleted.</p>
          <Button as="link" to="/">Back to dashboard</Button>
        </Banner>
      </Screen>
    );
  }

  const type = documentType(doc.type);
  const urgency = urgencyForDocument(doc);
  const archived = doc.status === 'archived';
  const isPdf = doc.file_kind === 'pdf' || doc.photo_type === 'application/pdf';

  return (
    <Screen
      title={documentLabel(doc)}
      subtitle={member?.name}
      back="/"
      actions={
        <Link
          to={`/documents/${doc.id}/edit`}
          className="rounded-lg px-2.5 py-2 text-[14px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
        >
          Edit
        </Link>
      }
      footer={
        archived ? (
          <div>
            <Button className="w-full" onClick={() => unarchiveDocument(doc.id)}>
              Restore to the dashboard
            </Button>
            <p className="mt-2 text-center text-[12px] text-slate-500 dark:text-slate-400">
              Puts it back among the live documents, with its reminders switched on again.
            </p>
          </div>
        ) : (
          <div>
            <div className="flex gap-2">
              <Button as="link" to={`/documents/${doc.id}/renew`} className="flex-1">
                Renew
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={async () => {
                  await archiveDocument(doc.id);
                  navigate('/', { replace: true });
                }}
              >
                Archive
              </Button>
            </div>
            {/* Two buttons that both make a document go away, for opposite
                reasons. Saying which is which here is cheaper than getting it
                wrong once. */}
            <p className="mt-2 text-center text-[12px] leading-snug text-slate-500 dark:text-slate-400">
              <span className="font-semibold">Renew</span> when you have the new one — this
              becomes history and the new one takes over.{' '}
              <span className="font-semibold">Archive</span> when you are done with it — kept,
              but off the dashboard and no longer reminded about.
            </p>
          </div>
        )
      }
    >
      <div className="space-y-3 pb-4">
        {doc.review_needed ? (
          <Banner tone="warn" title="Filed automatically — worth checking">
            <p className="mb-3">
              {doc.expiry_date || doc.no_expiry
                ? 'Some of this was hard to read.'
                : 'No expiry date was read, so no reminders will fire for it.'}
            </p>
            <Button as="link" to={`/documents/${doc.id}/edit`}>Check the details</Button>
          </Banner>
        ) : null}

        {archived ? (
          <Banner tone="info" title="Archived">
            Kept for history. It no longer appears on the dashboard and no reminders fire for it.
          </Banner>
        ) : null}

        <Card className="p-4">
          <div className="flex items-start gap-3">
            <span className="text-3xl" aria-hidden="true">{type.icon}</span>
            <div className="min-w-0 flex-1">
              <UrgencyChip urgency={urgency}>{expiryPhraseFor(doc)}</UrgencyChip>
              <p className="mt-2 text-[22px] font-bold tracking-tight">
                {doc.no_expiry
                  ? 'This document does not expire'
                  : doc.expiry_date
                    ? formatDate(doc.expiry_date)
                    : 'No expiry date set'}
              </p>
              {doc.expiry_date && !doc.no_expiry ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">Expiry date</p>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          <Detail label="Holder" value={member?.name ?? 'Unknown'} />
          <Detail label="Document number" value={doc.number || '—'} mono />
          <Detail label="Issued" value={doc.issue_date ? formatDate(doc.issue_date) : '—'} />
          <Detail label="Added" value={formatDate(doc.created_at?.slice(0, 10))} />
          {doc.notes ? <Detail label="Notes" value={doc.notes} wrap /> : null}
        </Card>

        {doc.extraction ? (
          <p className="px-1 text-[12px] text-slate-400 dark:text-slate-500">
            Read by {doc.extraction.model} on{' '}
            {formatDate(doc.extraction.extracted_at?.slice(0, 10))} ·{' '}
            {Math.round((doc.extraction.confidence ?? 0) * 100)}% confidence
          </p>
        ) : null}

        {doc.photo ? (
          <Card className="overflow-hidden">
            {/* A PDF is drawn into pictures rather than handed to a viewer the
                phone will refuse to open — see FilePreview. */}
            <button type="button" onClick={() => setFull(doc.photo)} className="block w-full" aria-label="View full size">
              <FilePreview blob={doc.photo} alt={`${documentLabel(doc)} scan`} maxPages={3} />
            </button>
            {doc.photo_back ? (
              <>
                <p className="border-t border-slate-100 px-3.5 py-2 text-[13px] font-semibold text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  Back
                </p>
                <button type="button" onClick={() => setFull(doc.photo_back)} className="block w-full" aria-label="View the back full size">
                  <FilePreview blob={doc.photo_back} alt={`${documentLabel(doc)} reverse`} maxPages={3} />
                </button>
              </>
            ) : null}
            <div className="flex divide-x divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setFull(doc.photo)}
                className="min-h-12 flex-1 text-[14px] font-semibold text-indigo-600 dark:text-indigo-400"
              >
                View full size
              </button>
              {isPdf && photoUrl ? (
                <a
                  href={photoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-12 flex-1 items-center justify-center text-[14px] font-semibold text-slate-600 dark:text-slate-300"
                >
                  Open the PDF
                </a>
              ) : null}
            </div>
          </Card>
        ) : (
          <Card className="p-4 text-center text-[14px] text-slate-500 dark:text-slate-400">
            No file saved for this document.
          </Card>
        )}

        <div className="pt-2">
          <Button
            variant={confirmDelete ? 'danger' : 'secondary'}
            className="w-full"
            onClick={async () => {
              if (!confirmDelete) { setConfirmDelete(true); return; }
              await deleteDocument(doc.id);
              navigate(archived ? '/archive' : '/', { replace: true });
            }}
          >
            {confirmDelete ? 'Delete permanently — this cannot be undone' : 'Delete this document'}
          </Button>
          {confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="mt-2 min-h-11 w-full text-[14px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
            >
              Cancel
            </button>
          ) : (
            <p className="mt-2 px-1 text-center text-[13px] text-slate-500 dark:text-slate-400">
              {archived
                ? 'Removes the record and its photo from this device.'
                : 'Archiving keeps it as history. Deleting removes it and its photo for good.'}
            </p>
          )}
        </div>

        {history.length > 0 ? (
          <Card className="overflow-hidden">
            <p className="px-3.5 pt-3 pb-2 text-[13px] font-bold text-slate-500 uppercase dark:text-slate-400">
              Previous versions
            </p>
            <div className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
              {history.map((old) => (
                <Link
                  key={old.id}
                  to={`/documents/${old.id}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <span className="text-[14px]">
                    Expired {old.expiry_date ? formatDate(old.expiry_date) : '—'}
                  </span>
                  <span className="text-[13px] text-slate-500 dark:text-slate-400">
                    {old.number || 'no number'}
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        ) : null}

        {full ? (
          <FullScreenPreview
            blob={full}
            alt={`${documentLabel(doc)} scan`}
            onClose={() => setFull(null)}
          />
        ) : null}
      </div>
    </Screen>
  );
}

function Detail({ label, value, mono, wrap }) {
  return (
    <div className="flex items-baseline gap-3 px-3.5 py-3">
      <span className="w-32 shrink-0 text-[13px] text-slate-500 dark:text-slate-400">{label}</span>
      <span
        className={`min-w-0 flex-1 text-[15px] font-medium ${mono ? 'font-mono tabular-nums' : ''} ${wrap ? 'whitespace-pre-wrap' : 'truncate'}`}
        dir="auto"
      >
        {value}
      </span>
    </div>
  );
}
