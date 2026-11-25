import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import { OWNER_LABEL, type ClaimSummary, type Owner, type StaffClaimDetail, type SupportRequest } from '@claims/shared';
import { api, fmtDateTime, fmtDate, fmtDuration, getConfig, openDocument, setStaffSession, staffDevSignIn, staffSession, staffSignIn, uploadDocument, useLoad, type Party } from './lib';

const PARTY_NAME: Record<Party, string> = { ngs: 'NGS Super', grow: 'GROW', tal: 'TAL' };
const PARTY_ROLE: Record<Party, string> = {
  ngs: 'Trustee portal',
  grow: 'Helpline and claims portal',
  tal: 'Insurer claims portal',
};

export function StaffLogin() {
  const nav = useNavigate();
  const local = getConfig().mode === 'local';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const go = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); nav('/staff'); } catch (e) { setError((e as Error).message); }
  };
  return (
    <main className="narrow">
      <h1>Staff sign in</h1>
      {local ? (
        <div className="card stack">
          <p className="muted">Local demo mode. Choose which party to sign in as.</p>
          {(['grow', 'ngs', 'tal'] as Party[]).map((p) => (
            <button key={p} className={`party-btn ${p}`} onClick={() => go(() => staffDevSignIn(p))}>{PARTY_NAME[p]} · {PARTY_ROLE[p]}</button>
          ))}
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <form className="card stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void go(() => staffSignIn(username, password)); }}>
          <label>Email<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary">Sign in</button>
        </form>
      )}
    </main>
  );
}

export function StaffShell() {
  const nav = useNavigate();
  const s = staffSession();
  if (!s) return <Navigate to="/staff/login" replace />;
  return (
    <div data-party={s.party}>
      <header className="staffbar">
        <div className="row">
          <strong>{PARTY_NAME[s.party]}</strong><span className="muted-inv">{PARTY_ROLE[s.party]}</span>
        </div>
        <nav className="row">
          <Link to="/staff">Claims</Link>
          {s.party === 'grow' && <Link to="/staff/new">Register claim</Link>}
          {s.party !== 'tal' && <Link to="/staff/requests">Claim Specialist Requests</Link>}
          <button className="link inv" onClick={() => { setStaffSession(null); nav('/'); }}>Sign out</button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

const STATUS_LABEL = { locked: 'Not started', in_progress: 'In progress', blocked: 'Blocked', completed: 'Complete' } as const;

/** Re-renders every 30 seconds so running timers stay current. */
function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** How long a claim has been open, or how long it took if it is finished. */
function OpenFor({ createdAt, closedAt, now }: { createdAt: string; closedAt?: string; now: number }) {
  const start = new Date(createdAt).getTime();
  return closedAt
    ? <span className="timer closed" title={`Closed ${fmtDateTime(closedAt)}`}>Closed after {fmtDuration(new Date(closedAt).getTime() - start)}</span>
    : <span className="timer">{fmtDuration(now - start)}</span>;
}

export function ClaimList() {
  const me = staffSession()!.party;
  const { data, error } = useLoad(() => api<ClaimSummary[]>('/staff/claims', { as: 'staff' }), [], 15000);
  const [mine, setMine] = useState(false);
  const now = useNow();
  if (error) return <main><p className="error">{error}</p></main>;
  if (!data) return <main><p>Loading…</p></main>;
  const needsMe = (c: ClaimSummary) => c.currentStep && c.waitingOn.includes(me);
  const rows = mine ? data.filter(needsMe) : data;
  return (
    <main>
      <div className="row between"><h1>Claims</h1>
        <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Waiting on {PARTY_NAME[me]} ({data.filter(needsMe).length})</label>
      </div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Claim</th><th>Member</th><th>Registered</th><th>Open for</th><th>Documents</th><th>Current step</th><th>Waiting on</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.claim.claimId}>
                <td><Link to={`/staff/claims/${c.claim.claimId}`}>{c.claim.claimId}</Link></td>
                <td>{c.claim.deceasedName}<div className="muted">{c.claimantCount} claimant{c.claimantCount === 1 ? '' : 's'}</div></td>
                <td>{fmtDate(c.claim.createdAt)}</td>
                <td><OpenFor createdAt={c.claim.createdAt} closedAt={c.closedAt} now={now} /></td>
                <td>{c.docsReceived}/{c.docsRequired}</td>
                <td>{c.currentStep ? <>{c.currentStep.id}. {c.currentStep.title} <span className={`chip ${c.currentStep.status}`}>{STATUS_LABEL[c.currentStep.status]}</span></> : <span className="chip completed">All steps complete</span>}</td>
                <td>{c.waitingOn.map((o) => <span key={o} className={`tag ${o === me ? 'me' : ''}`}>{OWNER_LABEL[o]}</span>)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}

interface Issued { claim: { claimId: string }; claimants: { claimantId: string; name: string; passcode: string }[] }

export function NewClaim() {
  const me = staffSession()!.party;
  const [deceasedName, setDeceasedName] = useState('');
  const [memberNumber, setMemberNumber] = useState('');
  const [claimants, setClaimants] = useState([{ name: '', relationship: '', email: '', phone: '' }]);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<Issued>();
  if (me !== 'grow') return <main><p>Only GROW registers claims.</p></main>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try { setIssued(await api<Issued>('/staff/claims', { as: 'staff', body: { deceasedName, memberNumber, claimants } })); }
    catch (err) { setError((err as Error).message); }
  }
  if (issued) {
    return (
      <main className="narrow">
        <h1>Claim registered</h1>
        <div className="card stack">
          <p>Give each claimant their sign-in details by phone or SMS. <strong>The passcodes are shown only once.</strong> You can issue a new one later if needed.</p>
          <p>Claim ID: <code className="big">{issued.claim.claimId}</code></p>
          {issued.claimants.map((c) => <p key={c.claimantId}>{c.name}: passcode <code className="big">{c.passcode}</code></p>)}
          <p className="muted">Family sign-in page: {location.origin}/family</p>
          <Link className="button primary" to={`/staff/claims/${issued.claim.claimId}`}>Open claim</Link>
        </div>
      </main>
    );
  }
  const set = (i: number, k: string, v: string) => setClaimants(claimants.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return (
    <main className="narrow">
      <h1>Register a claim</h1>
      <p className="lead">Use this after identity and cover have been confirmed on the call.</p>
      <form className="card stack" onSubmit={submit}>
        <label>Name of the member who passed away<input value={deceasedName} onChange={(e) => setDeceasedName(e.target.value)} required /></label>
        <label>Member number (optional)<input value={memberNumber} onChange={(e) => setMemberNumber(e.target.value)} /></label>
        <h2>Claimants</h2>
        {claimants.map((c, i) => (
          <fieldset key={i} className="stack">
            <legend>Claimant {i + 1}</legend>
            <label>Full name<input value={c.name} onChange={(e) => set(i, 'name', e.target.value)} required /></label>
            <label>Relationship to the member<input value={c.relationship} onChange={(e) => set(i, 'relationship', e.target.value)} required /></label>
            <div className="grid2">
              <label>Mobile<input value={c.phone} onChange={(e) => set(i, 'phone', e.target.value)} /></label>
              <label>Email<input value={c.email} onChange={(e) => set(i, 'email', e.target.value)} /></label>
            </div>
          </fieldset>
        ))}
        {claimants.length < 6 && <button type="button" className="secondary" onClick={() => setClaimants([...claimants, { name: '', relationship: '', email: '', phone: '' }])}>Add another claimant</button>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary">Register claim</button>
      </form>
    </main>
  );
}

export function ClaimDetail() {
  const { claimId = '' } = useParams();
  const me = staffSession()!.party;
  const { data, error, reload, set } = useLoad(() => api<StaffClaimDetail>(`/staff/claims/${claimId}`, { as: 'staff' }), [claimId], 15000);
  const [msg, setMsg] = useState('');
  const [passcode, setPasscode] = useState<{ name: string; code: string }>();
  const now = useNow();
  if (error && !data) return <main><p className="error">{error}</p></main>;
  if (!data) return <main><p>Loading…</p></main>;
  const base = `/staff/claims/${claimId}`;

  async function stepAction(stepId: number, action: 'done' | 'reopen' | 'block') {
    let note = '';
    if (action === 'block') {
      note = prompt('What is needed? The family and other parties will see this.') ?? '';
      if (!note.trim()) return;
    }
    setMsg('');
    try { set(await api<StaffClaimDetail>(`${base}/steps/${stepId}`, { as: 'staff', body: { action, note } })); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function reissue(claimantId: string, name: string) {
    if (!confirm(`Issue a new passcode for ${name}? The old one stops working.`)) return;
    const r = await api<{ passcode: string }>(`${base}/claimants/${claimantId}/passcode`, { as: 'staff', body: {} });
    setPasscode({ name, code: r.passcode });
  }
  const nameOf = (id: string | null) => (id ? data.claimants.find((c) => c.claimantId === id)?.name ?? id : 'Whole claim');

  return (
    <main>
      <p><Link to="/staff">← All claims</Link></p>
      <div className="row between wrap">
        <div><h1>{data.claim.claimId}</h1><p className="muted">Member: {data.claim.deceasedName}{data.claim.memberNumber && ` · #${data.claim.memberNumber}`} · registered {fmtDateTime(data.claim.createdAt)}</p></div>
        <div className="clock" aria-live="off">
          <span className="muted">{data.closedAt ? 'Total time to complete' : 'Open for'}</span>
          <strong><OpenFor createdAt={data.claim.createdAt} closedAt={data.closedAt} now={now} /></strong>
        </div>
      </div>
      {msg && <div className="banner attention" role="alert">{msg}</div>}

      <section className="card">
        <h2>Steps</h2>
        <ol className="staffsteps">
          {data.steps.map((s, i) => {
            const mine = s.owners.find((o) => o.owner === me);
            // A step starts when the one before it completes (the first starts at registration).
            const startedAt = i === 0 ? data.claim.createdAt : data.steps[i - 1]!.completedAt;
            const elapsed = startedAt && s.status !== 'locked' ? (s.completedAt ? new Date(s.completedAt).getTime() : now) - new Date(startedAt).getTime() : undefined;
            return (
              <li key={s.stepId} className={`sstep ${s.status}`}>
                <div className="row between wrap">
                  <strong>{s.stepId}. {s.title}</strong>
                  <span className="row">
                    {elapsed !== undefined && <span className="timer" title={`Started ${fmtDateTime(startedAt)}`}>{s.status === 'completed' ? `Took ${fmtDuration(elapsed)}` : `${fmtDuration(elapsed)} so far`}</span>}
                    <span className={`chip ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                  </span>
                </div>
                <div className="owners">
                  {s.owners.map(({ owner, state }) => (
                    <span key={owner} className={`owner ${state.status}`} title={state.updatedAt ? `${state.updatedBy} · ${fmtDateTime(state.updatedAt)}` : ''}>
                      {OWNER_LABEL[owner as Owner]}: {state.status === 'done' ? 'done' : state.status === 'blocked' ? 'blocked' : 'to do'}{state.note ? ` (${state.note})` : ''}
                    </span>
                  ))}
                </div>
                {mine && s.status !== 'locked' && (
                  <div className="row">
                    {mine.state.status !== 'done' && <button className="primary small" onClick={() => stepAction(s.stepId, 'done')}>Mark {PARTY_NAME[me]} part done</button>}
                    {mine.state.status === 'done' && <button className="secondary small" onClick={() => stepAction(s.stepId, 'reopen')}>Reopen</button>}
                    {mine.state.status !== 'done' && <button className="secondary small" onClick={() => stepAction(s.stepId, 'block')}>Flag a problem</button>}
                  </div>
                )}
                {mine && s.status === 'locked' && <p className="muted">Locked until the earlier steps are complete.</p>}
                {!mine && <p className="muted">View only. {s.owners.map((o) => OWNER_LABEL[o.owner as Owner]).join(' and ')} update{s.owners.length === 1 ? 's' : ''} this step.</p>}
              </li>
            );
          })}
        </ol>
        <p className="muted">A step completes for the family only when every owner above has marked it done. The next step unlocks at that point.</p>
      </section>

      <section className="card">
        <h2>Documents</h2>
        <table>
          <thead><tr><th>Document</th><th>For</th><th>File</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data.checklist.map((c) => <StaffDocRow key={c.slot + c.claimantId} base={base} item={c} forName={nameOf(c.claimantId)} onChange={reload} />)}
          </tbody>
        </table>
      </section>

      <div className="grid2">
        <section className="card stack">
          <h2>Claimants</h2>
          {data.claimants.map((c) => (
            <div key={c.claimantId} className="row between">
              <div><strong>{c.name}</strong> <span className="muted">{c.relationship}{c.phone && ` · ${c.phone}`}{c.email && ` · ${c.email}`}</span></div>
              {me !== 'tal' && <button className="secondary small" onClick={() => reissue(c.claimantId, c.name)}>New passcode</button>}
            </div>
          ))}
          {passcode && <div className="banner">New passcode for {passcode.name}: <code className="big">{passcode.code}</code></div>}
          {me !== 'tal' && <AddClaimant base={base} onAdded={(n, code) => { setPasscode({ name: n, code }); reload(); }} />}
        </section>

        <section className="card stack">
          <h2>Claim specialist requests</h2>
          {data.supportRequests.length === 0 && <p className="muted">None.</p>}
          {data.supportRequests.map((r) => <RequestRow key={r.requestId} r={r} canEdit={me !== 'tal'} onChange={reload} />)}
        </section>
      </div>

      <section className="card">
        <h2>Activity</h2>
        <ul className="audit">
          {data.audit.map((a, i) => <li key={i}><span className="muted">{fmtDateTime(a.at)}</span> <strong>{a.actor}</strong> {a.action.replace(/_/g, ' ')}{a.detail && <span className="muted"> · {a.detail}</span>}</li>)}
        </ul>
      </section>
    </main>
  );
}

function StaffDocRow({ base, item, forName, onChange }: { base: string; item: StaffClaimDetail['checklist'][number]; forName: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = item.doc;
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try { await uploadDocument(base, 'staff', { slot: item.slot, claimantId: item.claimantId, file }); onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  const has = d && d.status === 'uploaded';
  return (
    <tr>
      <td>{item.label}{item.optional && <span className="muted"> (optional)</span>}</td>
      <td>{forName}</td>
      <td>{has ? <><button className="link" onClick={() => openDocument(base, 'staff', d.docId)}>{d.fileName}</button><div className="muted">v{d.version} · {d.uploadedBy} · {fmtDateTime(d.uploadedAt)}</div></> : <span className="muted">Not received</span>}
        {has && d.classification?.mismatch && <div className="note">Looks like a different document type. Please check.</div>}
        {error && <div className="error">{error}</div>}</td>
      <td>{has ? <><span className={`chip ${d.verification === 'verified' ? 'completed' : d.verification === 'failed' ? 'blocked' : 'in_progress'}`}>{d.verification === 'not_started' ? 'Waiting for the full set' : d.verification === 'pending' ? 'With GreenID' : d.verification}</span>{d.verificationRef && <div className="muted">{d.verificationRef}</div>}</> : ''}</td>
      <td>
        <input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0])} />
        <button className="secondary small" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : has ? 'Replace' : 'Upload'}</button>
      </td>
    </tr>
  );
}

function AddClaimant({ base, onAdded }: { base: string; onAdded: (name: string, code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ name: string; passcode: string }>(`${base}/claimants`, { as: 'staff', body: { name, relationship } });
      onAdded(r.name, r.passcode); setOpen(false); setName(''); setRelationship('');
    } catch (err) { setError((err as Error).message); }
  }
  if (!open) return <button className="secondary" onClick={() => setOpen(true)}>Add claimant</button>;
  return (
    <form className="stack" onSubmit={submit}>
      <label>Full name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Relationship<input value={relationship} onChange={(e) => setRelationship(e.target.value)} required /></label>
      {error && <p className="error">{error}</p>}
      <div className="row"><button className="primary small">Add</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function RequestRow({ r, canEdit, onChange }: { r: SupportRequest; canEdit: boolean; onChange: () => void }) {
  const update = async (status: string) => { await api(`/staff/claims/${r.claimId}/requests/${r.requestId}`, { as: 'staff', body: { status } }); onChange(); };
  return (
    <div className="request">
      <div className="row between"><strong>{r.claimantName}</strong><span className={`chip ${r.status === 'open' ? 'blocked' : r.status === 'contacted' ? 'in_progress' : 'completed'}`}>{r.status}</span></div>
      <p>{r.phone}{r.preferredTime && ` · ${r.preferredTime}`}</p>
      {r.topic && <p className="muted">{r.topic}</p>}
      <p className="muted">Requested {fmtDateTime(r.createdAt)}</p>
      {canEdit && r.status !== 'closed' && (
        <div className="row">
          {r.status === 'open' && <button className="secondary small" onClick={() => update('contacted')}>Mark contacted</button>}
          <button className="secondary small" onClick={() => update('closed')}>Close</button>
        </div>
      )}
    </div>
  );
}

export function Requests() {
  const me = staffSession()!.party;
  const { data, error, reload } = useLoad(() => api<SupportRequest[]>('/staff/requests', { as: 'staff' }), [], 15000);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!data) return <main><p>Loading…</p></main>;
  return (
    <main className="narrow">
      <h1>Claim Specialist Requests</h1>
      <div className="stack">
        {data.length === 0 && <p className="muted">No requests.</p>}
        {data.map((r) => (
          <div className="card" key={r.requestId}>
            <p><Link to={`/staff/claims/${r.claimId}`}>{r.claimId}</Link></p>
            <RequestRow r={r} canEdit={me !== 'tal'} onChange={reload} />
          </div>
        ))}
      </div>
    </main>
  );
}
