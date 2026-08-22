import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import { addMember, db, deleteMember, updateMember } from '../db.js';
import { RELATIONS } from '../lib/constants.js';
import Screen from '../components/Screen.jsx';
import { Banner, Button, Field, Input, Select, Spinner } from '../components/ui.jsx';

export default function MemberForm({ mode }) {
  const { id } = useParams();
  const memberId = id ? Number(id) : null;
  const navigate = useNavigate();

  const member = useLiveQuery(
    () => (memberId ? db.members.get(memberId) : null),
    [memberId],
    memberId ? undefined : null,
  );
  const documentCount = useLiveQuery(
    () => (memberId ? db.documents.where('member_id').equals(memberId).count() : 0),
    [memberId],
    0,
  );

  const [name, setName] = useState('');
  const [relation, setRelation] = useState('Me');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (mode === 'edit' && member) {
      setName(member.name);
      setRelation(member.relation);
    }
  }, [mode, member]);

  async function handleSave() {
    if (!name.trim()) {
      setError('A name is required.');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'edit') {
        await updateMember(memberId, { name: name.trim(), relation });
        navigate('/', { replace: true });
      } else {
        const newId = await addMember({ name, relation });
        // Straight into adding their first document — that is why you added them.
        navigate(`/documents/new?member=${newId}`, { replace: true });
      }
    } catch (err) {
      setError(err?.message ?? 'Could not save.');
      setSaving(false);
    }
  }

  if (mode === 'edit' && member === undefined) {
    return (
      <Screen title="Edit member" back="/">
        <div className="flex justify-center py-16 text-slate-400"><Spinner className="size-7" /></div>
      </Screen>
    );
  }

  return (
    <Screen
      title={mode === 'edit' ? 'Edit family member' : 'Add family member'}
      back="/"
      footer={
        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? <Spinner /> : null}
          {mode === 'edit' ? 'Save changes' : 'Save and add a document'}
        </Button>
      }
    >
      <div className="space-y-4 pb-4">
        {error ? <Banner tone="error">{error}</Banner> : null}

        <Field label="Name" htmlFor="name" error={error && !name.trim() ? error : null}>
          <Input
            id="name"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            placeholder="Full name as printed on documents"
            autoComplete="name"
            dir="auto"
            autoFocus={mode !== 'edit'}
          />
        </Field>

        {mode === 'add' ? (
          <p className="px-1 text-[13px] text-slate-500 dark:text-slate-400">
            A placeholder is fine — "Maid 1" now, the real name later. You can rename anyone from
            the dashboard at any time and their documents follow them.
          </p>
        ) : null}

        <Field label="Relation" htmlFor="relation">
          <Select id="relation" value={relation} onChange={(e) => setRelation(e.target.value)}>
            {/* "Self" was the old label for "Me"; keep it selectable so an
                existing member does not silently change relation on edit. */}
            {(RELATIONS.includes(relation) ? RELATIONS : [relation, ...RELATIONS]).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </Select>
        </Field>

        {mode === 'edit' ? (
          <div className="pt-4">
            <Button
              variant={confirmDelete ? 'danger' : 'secondary'}
              className="w-full"
              onClick={async () => {
                if (!confirmDelete) { setConfirmDelete(true); return; }
                await deleteMember(memberId);
                navigate('/', { replace: true });
              }}
            >
              {confirmDelete
                ? `Delete ${name || 'this member'} and ${documentCount} document${documentCount === 1 ? '' : 's'}?`
                : 'Delete family member'}
            </Button>
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="mt-2 w-full text-[14px] text-slate-500 underline underline-offset-4 dark:text-slate-400"
              >
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Screen>
  );
}
