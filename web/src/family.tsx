import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { ChecklistView, FamilyStepView, FamilyTracker } from '@claims/shared';
import { LangRoot, LangSwitch, useI18n, type Key } from './i18n';
import { api, familySession, fmtDate, openDocument, setFamilySession, uploadDocument, useLoad } from './lib';

/** Language switch on the left, LifeLink logo on the right. To use the official logo, replace web/public/lifelink-logo.svg. */
function Topbar() {
  return (
    <div className="topbar branded">
      <LangSwitch />
      <img className="logo" src="/lifelink-logo.svg" alt="LifeLink" />
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
        <form id="family-login" className="card stack" onSubmit={submit}>
          <label>{t('claimId')}<input dir="ltr" value={claimId} onChange={(e) => setClaimId(e.target.value)} placeholder="NGS-XXXX-XXXX" autoComplete="off" required /></label>
          <label>{t('passcode')}<input dir="ltr" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="XXXX-XXXX" autoComplete="off" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? t('checking') : t('continue')}</button>
        </form>
        <Privacy />
      </main>
    </LangRoot>
  );
}

/** Mock privacy and consent text shown under the sign-in form. The checkbox belongs to the sign-in form, so it must be ticked to continue. */
function Privacy() {
  const { t } = useI18n();
  const uses: Key[] = ['privacyUse1', 'privacyUse2', 'privacyUse3', 'privacyUse4', 'privacyUse5', 'privacyUse6'];
  const controls: Key[] = ['control1', 'control2', 'control3', 'control4'];
  return (
    <section className="card privacy" aria-labelledby="privacy-title">
      <h2 id="privacy-title">{t('privacyTitle')}</h2>
      <p>{t('privacyIntro')}</p>
      <p>{t('privacyUseIntro')}</p>
      <ul>{uses.map((k) => <li key={k}>{t(k)}</li>)}</ul>
      <h3>{t('controlTitle')}</h3>
      <p>{t('controlIntro')}</p>
      <ul>{controls.map((k) => <li key={k}>{t(k)}</li>)}</ul>
      <p>{t('controlConsent')}</p>
      <label className="check consent">
        <input type="checkbox" form="family-login" required />
        <span>{t('consentCheck')}</span>
      </label>
    </section>
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
        <div className="hero">
          <div className="heroleft">
            <LangSwitch />
            <p className="muted">{t('claimMeta', { id: data.claim.claimId, date: fmtDate(data.claim.registeredAt, locale) })}</p>
            <h1>{t('hello', { name: data.claimant.name.split(' ')[0]! })}</h1>
            <p className="lead">{t('sorry', { deceased: data.claim.deceasedName })}</p>
          </div>
          <aside className="heroright">
            <button className="link" onClick={signOut}>{t('signOut')}</button>
            <div className="memberpanel">
              <div className="late">{t('theLate')} <strong>{data.claim.deceasedName}</strong></div>
              {data.claim.memberNumber && <div className="memberno" dir="ltr">{t('memberNumber', { n: data.claim.memberNumber })}</div>}
            </div>
          </aside>
        </div>

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
            <MyRequests requests={data.supportRequests} onChange={reload} />
          </div>
        </div>

        <Documents data={data} onChange={reload} />
      </main>
    </LangRoot>
  );
}

function Help({ data, onDone }: { data: FamilyTracker; onDone: () => void }) {
  const { t, errorText } = useI18n();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [preferredTime, setPreferredTime] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');
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

/** The family's own claim specialist requests. They can change the details or cancel until a specialist has been in touch. */
function MyRequests({ requests, onChange }: { requests: FamilyTracker['supportRequests']; onChange: () => void }) {
  const { t } = useI18n();
  if (requests.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="my-requests-title">
      <h2 id="my-requests-title">{t('myRequests')}</h2>
      {requests.some((r) => r.status === 'open') && <p className="muted">{t('requestEditNote')}</p>}
      {requests.map((r) => <RequestCard key={r.requestId} r={r} onChange={onChange} />)}
    </section>
  );
}

function RequestCard({ r, onChange }: { r: FamilyTracker['supportRequests'][number]; onChange: () => void }) {
  const { t, locale, errorText } = useI18n();
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(r.phone);
  const [preferredTime, setPreferredTime] = useState(r.preferredTime);
  const [topic, setTopic] = useState(r.topic);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canChange = r.status === 'open';

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); setEditing(false); onChange(); }
    catch (e) { setError(errorText(e)); onChange(); } // reload so a request staff have just picked up shows its new state
    finally { setBusy(false); }
  }
  const save = (e: FormEvent) => { e.preventDefault(); void run(() => api(`/family/support-requests/${r.requestId}`, { as: 'family', body: { phone, preferredTime, topic } })); };
  const cancel = () => { if (confirm(t('cancelConfirm'))) void run(() => api(`/family/support-requests/${r.requestId}/cancel`, { as: 'family', body: {} })); };

  return (
    <div className={`request ${r.status === 'cancelled' ? 'cancelled' : ''}`}>
      <div className="row between wrap">
        <span className="muted">{t('requestedOn', { date: fmtDate(r.createdAt, locale) })}</span>
        <span className={`chip ${r.status === 'open' ? 'current' : r.status === 'contacted' ? 'done' : ''}`}>{t(`reqStatus_${r.status}` as Key)}</span>
      </div>
      {!editing ? (
        <>
          <p dir="ltr" className="reqline">{r.phone}</p>
          {r.preferredTime && <p>{r.preferredTime}</p>}
          {r.topic && <p className="muted">{r.topic}</p>}
          {canChange && (
            <div className="row wrap">
              <button className="secondary small" disabled={busy} onClick={() => setEditing(true)}>{t('editRequest')}</button>
              <button className="link" disabled={busy} onClick={cancel}>{t('cancelRequest')}</button>
            </div>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={save}>
          <label>{t('phone')}<input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} required /></label>
          <label>{t('bestTime')}<input value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} placeholder={t('bestTimePh')} /></label>
          <label>{t('helpWith')}<textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} /></label>
          <div className="row"><button className="primary small" disabled={busy}>{t('saveChanges')}</button><button type="button" className="link" onClick={() => { setEditing(false); setPhone(r.phone); setPreferredTime(r.preferredTime); setTopic(r.topic); }}>{t('cancel')}</button></div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Documents({ data, onChange }: { data: FamilyTracker; onChange: () => void }) {
  const { t } = useI18n();
  const required = data.checklist.filter((c) => !c.optional);
  const done = required.filter((c) => c.doc).length;
  return (
    <section className="card">
      <h2>{t('docsTitle')}</h2>
      <p className="muted">{t('docsReady', { done, total: required.length })}</p>
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
  const [variant, setVariant] = useState(item.doc?.variant ?? '');
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      await uploadDocument('/family', 'family', { slot: item.slot, variant: item.choices ? variant : undefined, file });
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
        <strong>{t(`slot_${item.slot}` as Key)}</strong>{' '}
        <span className={`chip ${item.optional ? '' : 'attention'}`}>{item.optional ? t('optChip') : t('reqChip')}</span>
        <p className="muted">{t(`slot_${item.slot}_desc` as Key)}</p>
        {item.choices && (
          <label className="typepick">
            <span className="sr">{t('docType')}</span>
            <select value={variant} onChange={(e) => { setVariant(e.target.value); setError(''); }} aria-label={t('docType')}>
              <option value="">{t('chooseType')}</option>
              {item.choices.map((c) => <option key={c} value={c}>{t(`choice_${c}` as Key)}</option>)}
            </select>
          </label>
        )}
        {d && (
          <p>
            <button className="link" dir="ltr" onClick={() => openDocument('/family', 'family', d.docId)}>{d.fileName}</button>{' '}
            <span className={`chip ${failed ? 'attention' : d.verification === 'verified' ? 'done' : 'current'}`}>
              {failed ? t('pleaseUploadAgain') : d.verification === 'verified' ? t('verified') : t('received')}
            </span>
            {d.variant && <span className="muted"> · {t(`choice_${d.variant}` as Key)}</span>}
            {item.scope === 'claim' && !d.uploadedByYou && <span className="muted"> · {t('alreadyProvided')}</span>}
          </p>
        )}
        {failed && <p className="note">{t('verifyHint')}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div>
        <input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0])} />
        <button
          className={d && !failed ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => {
            if (item.choices && !variant) return setError(t('err_choose_type'));
            input.current?.click();
          }}
        >
          {busy ? t('uploading') : d ? (failed ? t('uploadAgain') : t('replace')) : t('upload')}
        </button>
      </div>
    </li>
  );
}
