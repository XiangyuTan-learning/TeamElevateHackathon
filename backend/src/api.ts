import { signFamilyToken, type Authenticator, type Principal } from './auth';
import { HttpError, type Service } from './service';

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>; // lower-case keys
  body?: string;
}
export interface ApiResponse {
  status: number;
  body: unknown;
}

type Staff = Extract<Principal, { kind: 'staff' }>;
type Family = Extract<Principal, { kind: 'family' }>;
type Ctx = { params: Record<string, string>; body: Record<string, unknown>; staff: () => Staff; family: () => Family };
type Handler = (c: Ctx) => Promise<unknown>;

export function createApi(service: Service, auth: Authenticator, getSecret: () => Promise<string>) {
  const routes: { method: string; re: RegExp; keys: string[]; public?: boolean; h: Handler }[] = [];
  const add = (method: string, path: string, h: Handler, pub = false) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, public: pub, h });
  };

  add('POST', '/family/login', async (c) => {
    const f = await service.familyLogin(c.body.claimId, c.body.passcode);
    return { token: signFamilyToken(f, await getSecret()), name: f.name, claimId: f.claimId };
  }, true);

  // family
  add('GET', '/family/tracker', (c) => service.familyTracker(c.family()));
  add('POST', '/family/documents', (c) => service.initUpload(c.family(), c.family().claimId, c.body));
  add('POST', '/family/documents/:docId/complete', (c) => service.completeUpload(c.family(), c.family().claimId, c.params.docId!));
  add('GET', '/family/documents/:docId/download', (c) => service.downloadUrl(c.family(), c.family().claimId, c.params.docId!));
  add('POST', '/family/support-requests', (c) => service.createSupportRequest(c.family(), c.body));
  add('POST', '/family/support-requests/:requestId', (c) => service.editSupportRequest(c.family(), c.params.requestId!, c.body));
  add('POST', '/family/support-requests/:requestId/cancel', (c) => service.cancelSupportRequest(c.family(), c.params.requestId!));

  // staff
  add('GET', '/staff/me', async (c) => ({ party: c.staff().party, username: c.staff().username }));
  add('GET', '/staff/claims', (c) => service.listClaims(c.staff()));
  add('POST', '/staff/claims', (c) => service.createClaim(c.staff(), c.body));
  add('GET', '/staff/claims/:claimId', (c) => service.staffClaimDetail(c.staff(), c.params.claimId!));
  add('POST', '/staff/claims/:claimId/steps/:stepId', async (c) => {
    await service.staffStepAction(c.staff(), c.params.claimId!, Number(c.params.stepId), c.body.action, c.body.note);
    return service.staffClaimDetail(c.staff(), c.params.claimId!);
  });
  add('POST', '/staff/claims/:claimId/claimants', (c) => service.addClaimant(c.staff(), c.params.claimId!, c.body));
  add('POST', '/staff/claims/:claimId/claimants/:claimantId', (c) => service.updateClaimant(c.staff(), c.params.claimId!, c.params.claimantId!, c.body));
  add('POST', '/staff/claims/:claimId/claimants/:claimantId/passcode', (c) => service.reissuePasscode(c.staff(), c.params.claimId!, c.params.claimantId!));
  add('POST', '/staff/claims/:claimId/documents', (c) => service.initUpload(c.staff(), c.params.claimId!, c.body));
  add('POST', '/staff/claims/:claimId/documents/:docId/complete', (c) => service.completeUpload(c.staff(), c.params.claimId!, c.params.docId!));
  add('GET', '/staff/claims/:claimId/documents/:docId/download', (c) => service.downloadUrl(c.staff(), c.params.claimId!, c.params.docId!));
  add('GET', '/staff/requests', (c) => service.listRequests(c.staff()));
  add('POST', '/staff/claims/:claimId/requests/:requestId', (c) => service.updateRequest(c.staff(), c.params.claimId!, c.params.requestId!, c.body.status));

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      const path = req.path.replace(/\/+$/, '') || '/';
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const principal = r.public ? undefined : await auth.authenticate(req.headers.authorization);
        if (!r.public && !principal) throw new HttpError(401, 'Please sign in');
        let body: Record<string, unknown> = {};
        if (req.body) {
          try {
            const parsed = JSON.parse(req.body);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
          } catch {
            throw new HttpError(400, 'Invalid JSON');
          }
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const ctx: Ctx = {
          params,
          body,
          staff: () => {
            if (principal?.kind !== 'staff') throw new HttpError(403, 'Staff only');
            return principal;
          },
          family: () => {
            if (principal?.kind !== 'family') throw new HttpError(403, 'Family only');
            return principal;
          },
        };
        return { status: 200, body: await r.h(ctx) };
      }
      return { status: pathMatched ? 405 : 404, body: { message: pathMatched ? 'Method not allowed' : 'Not found' } };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { message: e.message, code: e.code, params: e.params } };
      console.error(e);
      return { status: 500, body: { message: 'Something went wrong. Please try again.' } };
    }
  };
}
