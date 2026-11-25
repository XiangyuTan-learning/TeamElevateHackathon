import { createHmac, timingSafeEqual } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { PARTIES, type Party } from '@claims/shared';

export type Principal =
  | { kind: 'staff'; party: Party; username: string }
  | { kind: 'family'; claimId: string; claimantId: string; name: string };

export interface Authenticator {
  authenticate(authorizationHeader: string | undefined): Promise<Principal | undefined>;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signFamilyToken(p: Extract<Principal, { kind: 'family' }>, secret: string, ttlSeconds = 2 * 3600): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `fam.${body}.${sig}`;
}

export function verifyFamilyToken(token: string, secret: string): Extract<Principal, { kind: 'family' }> | undefined {
  const [prefix, body, sig] = token.split('.');
  if (prefix !== 'fam' || !body || !sig) return undefined;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { exp: number } & Extract<Principal, { kind: 'family' }>;
  if (p.exp < Date.now() / 1000) return undefined;
  return { kind: 'family', claimId: p.claimId, claimantId: p.claimantId, name: p.name };
}

const bearer = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : undefined);

/** Family tokens (signed by us) or Cognito ID tokens for staff. The Cognito group decides the party. */
export class CognitoAuthenticator implements Authenticator {
  private verifier;
  constructor(userPoolId: string, clientId: string, private getSecret: () => Promise<string>) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  }
  async authenticate(header?: string): Promise<Principal | undefined> {
    const token = bearer(header);
    if (!token) return undefined;
    if (token.startsWith('fam.')) return verifyFamilyToken(token, await this.getSecret());
    try {
      const claims = await this.verifier.verify(token);
      const groups = (claims['cognito:groups'] as string[] | undefined) ?? [];
      const party = PARTIES.find((p) => groups.includes(p));
      if (!party) return undefined;
      return { kind: 'staff', party, username: String(claims['cognito:username'] ?? claims.sub) };
    } catch {
      return undefined;
    }
  }
}

/** Local development only. "Authorization: Dev ngs" signs in as an NGS staff member. */
export class DevAuthenticator implements Authenticator {
  constructor(private secret: string) {}
  async authenticate(header?: string): Promise<Principal | undefined> {
    if (header?.startsWith('Dev ')) {
      const party = PARTIES.find((p) => p === header.slice(4).trim());
      return party ? { kind: 'staff', party, username: `${party}.demo` } : undefined;
    }
    const token = bearer(header);
    return token?.startsWith('fam.') ? verifyFamilyToken(token, this.secret) : undefined;
  }
}
