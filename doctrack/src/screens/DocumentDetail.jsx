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
import { expiryPhrase, formatDate, urgencyFor } from '../lib/dates.js';
import { previewUrl } from '../lib/files.js';
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const { url, revoke } = previewUrl(doc?.photo);
    setPhotoUrl(url);
    return revoke;
  }, [doc?.photo]);

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
  const urgency = urgencyFor(doc.expiry_date);
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
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => unarchiveDocument(doc.id)}>
              Restore
            </Button>
            <Button
              variant={confirmDelete ? 'danger' : 'secondary'}
              className="flex-1"
              onClick={async () => {
                if (!confirmDelete) { setConfirmDelete(true); return; }
                await deleteDocument(doc.id);
                navigate('/archive', { replace: true });
              }}
            >
              {confirmDelete ? 'Delete for good?' : 'Delete'}
            </Button>
          </div>
        ) : (
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
        )
      }
    >
      <div className="space-y-3 pb-4">
        {doc.review_needed ? (
          <Banner tone="warn" title="Filed automatically — worth checking">
            <p className="mb-3">
              {doc.expiry_date
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
              <UrgencyChip urgency={urgency}>{expiryPhrase(doc.expiry_date)}</UrgencyChip>
              <p className="mt-2 text-[22px] font-bold tracking-tight">
                {doc.expiry_date ? formatDate(doc.expiry_date) : 'No expiry date set'}
              </p>
              {doc.expiry_date ? (
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
            Auto-filled by {doc.extraction.model} on{' '}
            {formatDate(doc.extraction.extracted_at?.slice(0, 10))} ·{' '}
            {Math.round((doc.extraction.confidence ?? 0) * 100)}% confidence
          </p>
        ) : null}

        {photoUrl && isPdf ? (
          <Card className="overflow-hidden">
            {/* Phones mostly refuse to render a PDF inline, so offer the file
                rather than a blank grey box pretending to be a viewer. */}
            <object data={photoUrl} type="application/pdf" className="hidden h-96 w-full sm:block">
              <p className="p-4 text-[14px]">Your browser cannot display PDFs inline.</p>
            </object>
            <a
              href={photoUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-14 items-center gap-3 px-3.5 py-3 text-[15px] font-semibold text-indigo-600 dark:text-indigo-400"
            >
              <span className="text-xl" aria-hidden="true">📕</span>
              Open the PDF
            </a>
          </Card>
        ) : photoUrl ? (
          <Card className="overflow-hidden">
            <img src={photoUrl} alt={`${documentLabel(doc)} scan`} className="w-full bg-slate-100 object-contain dark:bg-slate-800" />
          </Card>
        ) : (
          <Card className="p-4 text-center text-[14px] text-slate-500 dark:text-slate-400">
            No file saved for this document.
          </Card>
        )}

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
