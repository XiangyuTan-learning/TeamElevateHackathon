import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { ChecklistView, FamilyStepView, FamilyTracker } from '@claims/shared';
import { LangRoot, LangSwitch, useI18n, type Key } from './i18n';
import { api, familySession, fmtDate, openDocument, setFamilySession, uploadDocument, useLoad } from './lib';

function Topbar({ onSignOut }: { onSignOut?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="topbar">
      <LangSwitch />
      {onSignOut && <button className="link" onClick={onSignOut}>{t('signOut')}</button>}
    </div>
  );
}

export function FamilyLogin() {
  const nav = useNavigate();
  const { t, errorText } = useI18n();
  const [claimId, setClaimId] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string; name: string; claimId: string }>('/family/login', { body: { claimId, passcode } });
      setFamilySession(r);
      nav('/family/claim');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LangRoot>
      <main className="narrow">
        <Topbar />
        <h1>{t('loginTitle')}</h1>
        <p className="lead">{t('loginLead')}</p>
        <form className="card stack" onSubmit={submit}>
          <label>{t('claimId')}<input dir="ltr" value={claimId} onChange={(e) => setClaimId(e.target.value)} placeholder="NGS-XXXX-XXXX" autoComplete="off" required /></label>
          <label>{t('passcode')}<input dir="ltr" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="XXXX-XXXX" autoComplete="off" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? t('checking') : t('continue')}</button>
        </form>
      </main>
    </LangRoot>
  );
}

const ICON: Record<FamilyStepView['status'], string> = { done: '✓', current: '●', attention: '!', upcoming: '' };

export function FamilyClaim() {
  const nav = useNavigate();
  const { t, locale, errorText } = useI18n();
  const session = familySession();
  const { data, error, reload } = useLoad(() => api<FamilyTracker>('/family/tracker', { as: 'family' }), [], 15000);
  if (!session) return <Navigate to="/family" replace />;
  if (error && !familySession()) return <Navigate to="/family" replace />;
  if (!data) return <LangRoot><main className="narrow"><Topbar /><p>{error ?? t('loading')}</p></main></LangRoot>;

  const needsAction = data.steps.some((s) => s.status === 'attention');
  const allDone = data.steps.every((s) => s.status === 'done');
  const signOut = () => { setFamilySession(null); nav('/'); };
  void errorText;
  return (
    <LangRoot>
      <main>
        <Topbar onSignOut={signOut} />
        <p className="muted">{t('claimMeta', { id: data.claim.claimId, date: fmtDate(data.claim.registeredAt, locale) })}</p>
        <h1>{t('hello', { name: data.claimant.name.split(' ')[0]! })}</h1>
        <p className="lead">{t('sorry', { deceased: data.claim.deceasedName })}</p>

        {needsAction && <div className="banner attention" role="alert">{t('actionBanner')}</div>}

        <div className="grid2">
          <section className="card">
            <h2>{t('whereUpTo')}</h2>
            <ol className="steps">
              <li className="step done"><span className="dot">✓</span><div><strong>{t('registered')}</strong><p className="muted">{t('registeredDesc')}</p></div></li>
              {data.steps.map((s) => (
                <li key={s.stepId} className={`step ${s.status}`}>
                  <span className="dot" aria-hidden>{ICON[s.status]}</span>
                  <div>
                    <strong>{t(`stepTitle${s.stepId}` as Key)}</strong> <span className={`chip ${s.status}`}>{t(`status_${s.status}` as Key)}</span>
                    <p className="muted">{t(`stepDesc${s.stepId}` as Key)}</p>
                    {s.status !== 'done' && s.status !== 'upcoming' && s.waitingOn.length > 0 && (
                      <p className="waiting">{t('waitingOn', { who: s.waitingOn.map((o) => t(`who_${o}` as Key)).join(', ') })}</p>
                    )}
                    {/* The documents step explains itself per document, in the family's language. Other notes are written by staff. */}
                    {s.note && s.stepId !== 3 && <p className="note">{s.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="stack">
            {!allDone && data.estimate && (
              <section className="card estimate">
                <h2>{t('estimateTitle')}</h2>
                <p className="big">{t('estimateRange', { min: Math.max(1, Math.round(data.estimate.remainingDays.min)), max: Math.ceil(data.estimate.remainingDays.max) })}</p>
                <p className="muted">{t('estimateBody', { avg: Math.round(data.estimate.remainingDays.avg), n: data.estimate.basedOnCases })}</p>
              </section>
            )}
            <Help data={data} onDone={reload} />
          </div>
        </div>

        <Documents data={data} onChange={reload} />
      </main>
    </LangRoot>
  );
}

function Help({ data, onDone }: { data: FamilyTracker; onDone: () => void }) {
  const { t, locale, errorText } = useI18n();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [preferredTime, setPreferredTime] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');
  const latest = data.supportRequests[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/family/support-requests', { as: 'family', body: { phone, preferredTime, topic } });
      setOpen(false); setPhone(''); setPreferredTime(''); setTopic('');
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <section className="card stack">
      <h2>{t('supportTitle')}</h2>
      <div>
        <p><strong>{t('counselTitle')}</strong></p>
        <p className="muted">{t('counselBody')}</p>
        <a className="button secondary" href={data.counsellingUrl} target="_blank" rel="noopener noreferrer">{t('counselBtn')}</a>
      </div>
      <hr />
      <div>
        <p><strong>{t('specialistTitle')}</strong></p>
        <p className="muted">{t('specialistBody')}</p>
        {latest && latest.status !== 'closed' && (
          <p className="waiting">{t(latest.status === 'open' ? 'requestOpen' : 'requestContacted', { date: fmtDate(latest.createdAt, locale) })}</p>
        )}
        {!open ? <button className="secondary" onClick={() => setOpen(true)}>{t('requestCall')}</button> : (
          <form className="stack" onSubmit={submit}>
            <label>{t('phone')}<input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} required /></label>
            <label>{t('bestTime')}<input value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} placeholder={t('bestTimePh')} /></label>
            <label>{t('helpWith')}<textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row"><button className="primary">{t('send')}</button><button type="button" className="link" onClick={() => setOpen(false)}>{t('cancel')}</button></div>
          </form>
        )}
      </div>
    </section>
  );
}

function Documents({ data, onChange }: { data: FamilyTracker; onChange: () => void }) {
  const { t } = useI18n();
  const done = data.checklist.filter((c) => c.doc || c.optional).length;
  return (
    <section className="card">
      <h2>{t('docsTitle')}</h2>
      <p className="muted">{t('docsReady', { done, total: data.checklist.length })}</p>
      <ul className="docs">
        {data.checklist.map((item) => <DocRow key={item.slot} item={item} onChange={onChange} />)}
      </ul>
    </section>
  );
}

function DocRow({ item, onChange }: { item: ChecklistView; onChange: () => void }) {
  const { t, errorText } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      await uploadDocument('/family', 'family', { slot: item.slot, file });
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  const d = item.doc;
  const failed = d?.verification === 'failed';
  return (
    <li className="docrow">
      <div>
        <strong>{t(`slot_${item.slot}` as Key)}</strong>{item.optional && <span className="muted"> {t('optional')}</span>}
        <p className="muted">{t(`slot_${item.slot}_desc` as Key)}</p>
        {d && (
          <p>
            <button className="link" dir="ltr" onClick={() => openDocument('/family', 'family', d.docId)}>{d.fileName}</button>{' '}
            <span className={`chip ${failed ? 'attention' : d.verification === 'verified' ? 'done' : 'current'}`}>
              {failed ? t('pleaseUploadAgain') : d.verification === 'verified' ? t('verified') : t('received')}
            </span>
            {item.scope === 'claim' && !d.uploadedByYou && <span className="muted"> · {t('alreadyProvided')}</span>}
          </p>
        )}
        {failed && <p className="note">{t('verifyHint')}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div>
        <input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0])} />
        <button className={d && !failed ? 'secondary' : 'primary'} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t('uploading') : d ? (failed ? t('uploadAgain') : t('replace')) : t('upload')}
        </button>
      </div>
    </li>
  );
}
