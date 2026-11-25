import type { AuditEntry, Claim, Claimant, DocRecord, StepState, SupportRequest } from '@claims/shared';
import type { Item, KV } from './kv';

export interface ClaimantSecret extends Claimant {
  salt: string;
  passcodeHash: string;
}
export interface ClaimLockState {
  failures: number;
  lockedUntil?: string;
}
export interface StatItem {
  stepId: number;
  claimId: string;
  days: number;
}

const strip = <T>(i: Item | undefined): T | undefined => {
  if (!i) return undefined;
  const { pk, sk, gsi1pk, gsi1sk, ...rest } = i;
  void pk; void sk; void gsi1pk; void gsi1sk;
  return rest as T;
};
const stripAll = <T>(items: Item[]): T[] => items.map((i) => strip<T>(i)!);
const C = (claimId: string) => `CLAIM#${claimId}`;

export class Repo {
  constructor(private kv: KV) {}

  // claims
  putClaim(c: Claim) {
    return this.kv.put({ pk: C(c.claimId), sk: 'META', gsi1pk: 'CLAIM', gsi1sk: c.createdAt, ...c });
  }
  async getClaim(id: string) {
    return strip<Claim>(await this.kv.get(C(id), 'META'));
  }
  async listClaims() {
    return stripAll<Claim>(await this.kv.queryIndex('CLAIM'));
  }
  async getLock(id: string): Promise<ClaimLockState> {
    return strip<ClaimLockState>(await this.kv.get(C(id), 'LOCK')) ?? { failures: 0 };
  }
  putLock(id: string, l: ClaimLockState) {
    return this.kv.put({ pk: C(id), sk: 'LOCK', ...l });
  }

  // claimants
  putClaimant(c: ClaimantSecret) {
    return this.kv.put({ pk: C(c.claimId), sk: `CLAIMANT#${c.claimantId}`, ...c });
  }
  async getClaimant(claimId: string, claimantId: string) {
    return strip<ClaimantSecret>(await this.kv.get(C(claimId), `CLAIMANT#${claimantId}`));
  }
  async listClaimants(claimId: string) {
    return stripAll<ClaimantSecret>(await this.kv.query(C(claimId), 'CLAIMANT#'));
  }

  // steps
  putStep(s: StepState) {
    return this.kv.put({ pk: C(s.claimId), sk: `STEP#${s.stepId}`, ...s });
  }
  async listSteps(claimId: string) {
    return stripAll<StepState>(await this.kv.query(C(claimId), 'STEP#'));
  }

  // documents
  putDoc(d: DocRecord) {
    return this.kv.put({ pk: C(d.claimId), sk: `DOC#${d.docId}`, ...d });
  }
  async getDoc(claimId: string, docId: string) {
    return strip<DocRecord>(await this.kv.get(C(claimId), `DOC#${docId}`));
  }
  async listDocs(claimId: string) {
    return stripAll<DocRecord>(await this.kv.query(C(claimId), 'DOC#'));
  }
  delDoc(claimId: string, docId: string) {
    return this.kv.del(C(claimId), `DOC#${docId}`);
  }

  // audit
  addAudit(claimId: string, e: AuditEntry) {
    return this.kv.put({ pk: C(claimId), sk: `AUDIT#${e.at}#${Math.random().toString(36).slice(2, 7)}`, ...e });
  }
  async listAudit(claimId: string) {
    return stripAll<AuditEntry>(await this.kv.query(C(claimId), 'AUDIT#')).reverse();
  }

  // support requests
  putRequest(r: SupportRequest) {
    return this.kv.put({ pk: C(r.claimId), sk: `REQ#${r.requestId}`, gsi1pk: 'REQ', gsi1sk: r.createdAt, ...r });
  }
  async getRequest(claimId: string, requestId: string) {
    return strip<SupportRequest>(await this.kv.get(C(claimId), `REQ#${requestId}`));
  }
  async listRequests() {
    return stripAll<SupportRequest>(await this.kv.queryIndex('REQ'));
  }
  async listClaimRequests(claimId: string) {
    return stripAll<SupportRequest>(await this.kv.query(C(claimId), 'REQ#')).reverse();
  }

  // duration statistics for the estimate
  putStat(s: StatItem) {
    return this.kv.put({ pk: 'STATS', sk: `STEP#${s.stepId}#${s.claimId}`, ...s });
  }
  async listStats(stepId: number) {
    return stripAll<StatItem>(await this.kv.query('STATS', `STEP#${stepId}#`));
  }
}
