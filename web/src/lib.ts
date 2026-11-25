import { useEffect, useState } from 'react';

export interface AppConfig {
  mode: 'local' | 'aws';
  apiUrl: string;
  region?: string;
  clientId?: string;
}
let config: AppConfig;
export async function loadConfig() {
  config = await (await fetch('/config.json', { cache: 'no-store' })).json();
  return config;
}
export const getConfig = () => config;

// ---------- Session ----------

export type Party = 'ngs' | 'grow' | 'tal';
interface FamilySession { token: string; name: string; claimId: string }
interface StaffSession { token: string; party: Party; username: string }
const read = <T,>(k: string): T | null => {
  try { return JSON.parse(sessionStorage.getItem(k) ?? 'null'); } catch { return null; }
};
export const familySession = () => read<FamilySession>('family');
export const staffSession = () => read<StaffSession>('staff');
export const setFamilySession = (s: FamilySession | null) => (s ? sessionStorage.setItem('family', JSON.stringify(s)) : sessionStorage.removeItem('family'));
export const setStaffSession = (s: StaffSession | null) => (s ? sessionStorage.setItem('staff', JSON.stringify(s)) : sessionStorage.removeItem('staff'));

// ---------- API ----------

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public params?: Record<string, string>) { super(message); }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; as?: 'family' | 'staff' | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.as === 'family') {
    const s = familySession();
    if (s) headers.authorization = `Bearer ${s.token}`;
  } else if (opts.as === 'staff') {
    const s = staffSession();
    if (s) headers.authorization = s.token;
  }
  const r = await fetch(config.apiUrl + path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && opts.as) {
      if (opts.as === 'family') setFamilySession(null); else setStaffSession(null);
    }
    throw new ApiError(r.status, data.message ?? 'Something went wrong', data.code, data.params);
  }
  return data as T;
}

/** Uploads through a presigned URL, then asks the API to verify and file the document. */
export async function uploadDocument(base: string, as: 'family' | 'staff', input: { slot: string; claimantId?: string | null; file: File }) {
  const { file } = input;
  const init = await api<{ docId: string; uploadUrl: string; headers: Record<string, string> }>(`${base}/documents`, {
    as,
    body: { slot: input.slot, claimantId: input.claimantId ?? undefined, fileName: file.name, contentType: file.type, size: file.size },
  });
  const put = await fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: file });
  if (!put.ok) throw new ApiError(0, 'The upload did not complete. Please try again.', 'upload_incomplete');
  await api(`${base}/documents/${init.docId}/complete`, { method: 'POST', as, body: {} });
}

export async function openDocument(base: string, as: 'family' | 'staff', docId: string) {
  const r = await api<{ url: string }>(`${base}/documents/${docId}/download`, { as });
  window.open(r.url, '_blank', 'noopener');
}

// ---------- Staff sign-in ----------

export async function staffSignIn(username: string, password: string) {
  const cfg = getConfig();
  const r = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cfg.clientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  });
  const data = await r.json();
  const token = data.AuthenticationResult?.IdToken as string | undefined;
  if (!token) throw new Error('Those sign-in details were not recognised.');
  await finishStaff(`Bearer ${token}`);
}
export async function staffDevSignIn(party: Party) {
  await finishStaff(`Dev ${party}`);
}
async function finishStaff(token: string) {
  setStaffSession({ token, party: 'ngs', username: '' });
  try {
    const me = await api<{ party: Party; username: string }>('/staff/me', { as: 'staff' });
    setStaffSession({ token, party: me.party, username: me.username });
  } catch (e) {
    setStaffSession(null);
    throw e;
  }
}

// ---------- Hooks and formatting ----------

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(undefined))).catch((e) => live && setError(e.message));
    const t = pollMs ? setInterval(() => setTick((x) => x + 1), pollMs) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((x) => x + 1), set: setData };
}

export const fmtDate = (iso?: string, locale = 'en-AU') => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtDateTime = (iso?: string, locale = 'en-AU') => (iso ? new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/** "3d 4h", "5h 12m" or "under 1m". */
export function fmtDuration(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return min > 0 ? `${min}m` : 'under 1m';
}
