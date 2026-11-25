import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  ALLOWED_CONTENT_TYPES,
  CHECKLISTS,
  DEFAULT_CLAIM_TYPE,
  MAX_UPLOAD_BYTES,
  OWNER_LABEL,
  STEPS,
  deriveSteps,
  emptyStepState,
  type AuditEntry,
  type Claim,
  type ChecklistItem,
  type ChecklistView,
  type ClaimSummary,
  type DocRecord,
  type Estimate,
  type FamilyStepView,
  type FamilyTracker,
  type Owner,
  type Party,
  type StaffClaimDetail,
  type StepState,
  type SupportRequest,
} from '@claims/shared';
import type { Principal } from './auth';
import type { Blob } from './blob';
import type { Classifier } from './classifier';
import type { GreenId } from './greenid';
import type { ClaimantSecret, Repo } from './repo';

/** `code` and `params` let the family portal show the message in the family's language. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public params?: Record<string, string>) {
    super(message);
  }
}

type Staff = Extract<Principal, { kind: 'staff' }>;
type Family = Extract<Principal, { kind: 'family' }>;

export interface Deps {
  repo: Repo;
  blob: Blob;
  classifier: Classifier;
  greenId: GreenId;
  startVerification: (claimId: string) => Promise<void>;
  counsellingUrl: string;
  now?: () => Date;
}

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
const randomString = (n: number) => Array.from({ length: n }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
const hashPasscode = (passcode: string, salt: string) => scryptSync(passcode, salt, 32).toString('hex');
const normaliseCode = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const PASSCODE_DAYS = 7;
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

const text = (v: unknown, field: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
};

export class Service {
  private repo: Repo;
  constructor(private d: Deps) {
    this.repo = d.repo;
  }
  private now = () => (this.d.now ? this.d.now() : new Date());
  private iso = () => this.now().toISOString();
  private who = (p: Principal) => (p.kind === 'staff' ? `${p.party}:${p.username}` : `family:${p.claimantId}`);
  private async audit(claimId: string, actor: string, action: string, detail?: string) {
    const e: AuditEntry = { at: this.iso(), actor, action, detail };
    await this.repo.addAudit(claimId, e);
  }
  private async mustClaim(claimId: string): Promise<Claim> {
    const c = await this.repo.getClaim(claimId);
    if (!c) throw new HttpError(404, 'Claim not found');
    return c;
  }
  private checklist(claim: Claim): ChecklistItem[] {
    return CHECKLISTS[claim.claimType] ?? CHECKLISTS[DEFAULT_CLAIM_TYPE]!;
  }

  // ---------- Claims and claimants ----------

  private async newClaimant(claimId: string, index: number, input: { name: unknown; relationship: unknown; email?: unknown; phone?: unknown }) {
    const passcode = `${randomString(4)}-${randomString(4)}`;
    const salt = randomBytes(16).toString('hex');
    const c: ClaimantSecret = {
      claimantId: `C${index}`,
      claimId,
      name: text(input.name, 'Claimant name', 100),
      relationship: text(input.relationship, 'Relationship', 100),
      email: text(input.email, 'Email', 200, false) || undefined,
      phone: text(input.phone, 'Phone', 40, false) || undefined,
      salt,
      passcodeHash: hashPasscode(normaliseCode(passcode), salt),
      passcodeExpiresAt: new Date(this.now().getTime() + PASSCODE_DAYS * 86400000).toISOString(),
    };
    await this.repo.putClaimant(c);
    return { claimantId: c.claimantId, name: c.name, passcode };
  }

  /** Called by a GROW (Concentrix) agent once identity and cover are confirmed on the call. */
  async createClaim(actor: Staff, input: { deceasedName?: unknown; memberNumber?: unknown; claimants?: unknown }) {
    if (actor.party !== 'grow') throw new HttpError(403, 'Only GROW can register claims');
    const claimants = Array.isArray(input.claimants) ? input.claimants : [];
    if (claimants.length < 1 || claimants.length > 6) throw new HttpError(400, 'Add between 1 and 6 claimants');
    const now = this.iso();
    const claim: Claim = {
      claimId: `NGS-${randomString(4)}-${randomString(4)}`,
      deceasedName: text(input.deceasedName, 'Name of the member', 100),
      memberNumber: text(input.memberNumber, 'Member number', 40, false) || undefined,
      claimType: DEFAULT_CLAIM_TYPE,
      createdAt: now,
      createdBy: this.who(actor),
    };
    await this.repo.putClaim(claim);
    for (const def of STEPS) {
      const s = emptyStepState(claim.claimId, def);
      if (def.id <= 2) {
        s.owners.grow = { status: 'done', updatedBy: this.who(actor), updatedAt: now };
        s.completedAt = now;
      }
      await this.repo.putStep(s);
    }
    const issued = [];
    for (const [i, c] of claimants.entries()) issued.push(await this.newClaimant(claim.claimId, i + 1, c as never));
    await this.audit(claim.claimId, this.who(actor), 'claim_registered', `${issued.length} claimant(s)`);
    return { claim, claimants: issued };
  }

  async addClaimant(actor: Staff, claimId: string, input: { name?: unknown; relationship?: unknown; email?: unknown; phone?: unknown }) {
    if (actor.party === 'tal') throw new HttpError(403, 'Only NGS or GROW can add claimants');
    await this.mustClaim(claimId);
    const existing = await this.repo.listClaimants(claimId);
    const next = Math.max(0, ...existing.map((c) => Number(c.claimantId.slice(1)))) + 1;
    const issued = await this.newClaimant(claimId, next, input as never);
    await this.audit(claimId, this.who(actor), 'claimant_added', issued.claimantId);
    await this.afterDocChange(claimId);
    return issued;
  }

  async reissuePasscode(actor: Staff, claimId: string, claimantId: string) {
    if (actor.party === 'tal') throw new HttpError(403, 'Only NGS or GROW can reissue passcodes');
    const c = await this.repo.getClaimant(claimId, claimantId);
    if (!c) throw new HttpError(404, 'Claimant not found');
    const passcode = `${randomString(4)}-${randomString(4)}`;
    c.salt = randomBytes(16).toString('hex');
    c.passcodeHash = hashPasscode(normaliseCode(passcode), c.salt);
    c.passcodeExpiresAt = new Date(this.now().getTime() + PASSCODE_DAYS * 86400000).toISOString();
    await this.repo.putClaimant(c);
    await this.repo.putLock(claimId, { failures: 0 });
    await this.audit(claimId, this.who(actor), 'passcode_reissued', claimantId);
    return { claimantId, passcode };
  }

  // ---------- Family sign-in ----------

  async familyLogin(claimIdIn: unknown, passcodeIn: unknown): Promise<Family> {
    const generic = new HttpError(401, 'We could not match that claim ID and passcode. Please check them and try again.', 'login_failed');
    const claimId = typeof claimIdIn === 'string' ? claimIdIn.trim().toUpperCase() : '';
    const code = typeof passcodeIn === 'string' ? normaliseCode(passcodeIn) : '';
    if (!claimId || !code) throw generic;
    const claim = await this.repo.getClaim(claimId);
    if (!claim) throw generic;
    const lock = await this.repo.getLock(claimId);
    if (lock.lockedUntil && lock.lockedUntil > this.iso()) throw new HttpError(429, 'Too many attempts. Please try again in 15 minutes, or call us for a new passcode.', 'login_locked');
    for (const c of await this.repo.listClaimants(claimId)) {
      const a = Buffer.from(hashPasscode(code, c.salt), 'hex');
      const b = Buffer.from(c.passcodeHash, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        if (c.passcodeExpiresAt < this.iso()) throw new HttpError(401, 'This passcode has expired. Please call us for a new one.', 'passcode_expired');
        await this.repo.putLock(claimId, { failures: 0 });
        await this.audit(claimId, `family:${c.claimantId}`, 'family_signed_in');
        return { kind: 'family', claimId, claimantId: c.claimantId, name: c.name };
      }
    }
    const failures = lock.failures + 1;
    await this.repo.putLock(claimId, failures >= MAX_FAILURES ? { failures: 0, lockedUntil: new Date(this.now().getTime() + LOCK_MINUTES * 60000).toISOString() } : { failures });
    throw generic;
  }

  // ---------- Steps ----------

  private async loadSteps(claimId: string): Promise<StepState[]> {
    const have = await this.repo.listSteps(claimId);
    return STEPS.map((d) => have.find((s) => s.stepId === d.id) ?? emptyStepState(claimId, d));
  }

  /** Applies a change, then re-derives completion times. Records duration statistics when the last step completes. */
  private async mutateStep(claimId: string, stepId: number, owner: Owner, status: 'pending' | 'done' | 'blocked', note: string | undefined, by: string) {
    const states = await this.loadSteps(claimId);
    const wasFinished = deriveSteps(states).every((s) => s.status === 'completed');
    const target = states.find((s) => s.stepId === stepId)!;
    target.owners[owner] = { status, note, updatedBy: by, updatedAt: this.iso() };
    const changed = new Set<number>([stepId]);
    for (const def of STEPS) {
      const st = states.find((s) => s.stepId === def.id)!;
      const complete = def.owners.every((o) => st.owners[o]?.status === 'done');
      if (complete && !st.completedAt) { st.completedAt = this.iso(); changed.add(def.id); }
      if (!complete && st.completedAt) { delete st.completedAt; changed.add(def.id); }
    }
    for (const id of changed) await this.repo.putStep(states.find((s) => s.stepId === id)!);
    const finished = deriveSteps(states).every((s) => s.status === 'completed');
    if (finished && !wasFinished) await this.recordStats(claimId, states);
  }

  private async recordStats(claimId: string, states: StepState[]) {
    const claim = await this.mustClaim(claimId);
    let prev = new Date(claim.createdAt).getTime();
    for (const def of STEPS) {
      const end = new Date(states.find((s) => s.stepId === def.id)!.completedAt!).getTime();
      if (def.id >= 3) await this.repo.putStat({ stepId: def.id, claimId, days: Math.max(0, (end - prev) / 86400000) });
      prev = Math.max(prev, end);
    }
  }

  async staffStepAction(actor: Staff, claimId: string, stepId: number, action: unknown, noteIn: unknown) {
    await this.mustClaim(claimId);
    const def = STEPS.find((s) => s.id === stepId);
    if (!def) throw new HttpError(404, 'Step not found');
    if (!def.owners.includes(actor.party)) throw new HttpError(403, `${OWNER_LABEL[actor.party]} does not own this step`);
    const derived = deriveSteps(await this.loadSteps(claimId), claimId);
    const me = derived[stepId - 1]!;
    if (me.status === 'locked') throw new HttpError(409, 'An earlier step is not complete yet');
    const note = text(noteIn, 'Note', 500, false) || undefined;
    if (action === 'done') {
      await this.mutateStep(claimId, stepId, actor.party, 'done', note, this.who(actor));
    } else if (action === 'reopen') {
      const next = derived[stepId];
      if (next && next.status === 'completed') throw new HttpError(409, 'The next step is already complete');
      await this.mutateStep(claimId, stepId, actor.party, 'pending', note, this.who(actor));
    } else if (action === 'block') {
      if (!note) throw new HttpError(400, 'Add a note explaining what is needed');
      await this.mutateStep(claimId, stepId, actor.party, 'blocked', note, this.who(actor));
    } else throw new HttpError(400, 'Unknown action');
    await this.audit(claimId, this.who(actor), `step_${action}`, `${def.title}${note ? `: ${note}` : ''}`);
  }

  // ---------- Documents ----------

  private slotSatisfied(d: DocRecord | undefined) {
    return !!d && d.status === 'uploaded' && d.verification !== 'failed';
  }
  private requiredEntries(claim: Claim, claimantIds: string[]) {
    const out: { item: ChecklistItem; claimantId: string | null }[] = [];
    for (const item of this.checklist(claim)) {
      if (item.scope === 'claim') out.push({ item, claimantId: null });
      else for (const id of claimantIds) out.push({ item, claimantId: id });
    }
    return out;
  }
  private findDoc(docs: DocRecord[], slot: string, claimantId: string | null) {
    return docs.find((d) => d.slot === slot && d.claimantId === claimantId);
  }

  async initUpload(actor: Principal, claimId: string, input: { slot?: unknown; claimantId?: unknown; fileName?: unknown; contentType?: unknown; size?: unknown }) {
    const claim = await this.mustClaim(claimId);
    this.assertClaimAccess(actor, claimId);
    const item = this.checklist(claim).find((i) => i.slot === input.slot);
    if (!item) throw new HttpError(400, 'Unknown document type');
    const fileName = text(input.fileName, 'File name', 200);
    const contentType = text(input.contentType, 'Content type', 100);
    const size = Number(input.size);
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) throw new HttpError(400, 'Please upload a PDF, JPG or PNG file', 'file_type');
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new HttpError(400, 'Files must be under 15 MB', 'file_size');
    let claimantId: string | null = null;
    if (item.scope === 'claimant') {
      claimantId = actor.kind === 'family' ? actor.claimantId : text(input.claimantId, 'Claimant', 20);
      if (!(await this.repo.getClaimant(claimId, claimantId))) throw new HttpError(404, 'Claimant not found');
    }
    const docs = await this.repo.listDocs(claimId);
    const existing = this.findDoc(docs, item.slot, claimantId);
    const doc: DocRecord = existing ?? {
      docId: randomBytes(6).toString('hex'),
      claimId,
      slot: item.slot,
      claimantId,
      fileName: '',
      contentType,
      size: 0,
      version: 0,
      status: 'awaiting_upload',
      verification: 'not_started',
    };
    const key = `claims/${claimId}/${doc.docId}/v${doc.version + 1}`;
    doc.pending = { fileName, contentType, size, key };
    await this.repo.putDoc(doc);
    const { url, headers } = await this.d.blob.presignUpload(key, contentType);
    return { docId: doc.docId, uploadUrl: url, headers, key };
  }

  async completeUpload(actor: Principal, claimId: string, docId: string) {
    const claim = await this.mustClaim(claimId);
    this.assertClaimAccess(actor, claimId);
    const doc = await this.repo.getDoc(claimId, docId);
    if (!doc || !doc.pending) throw new HttpError(404, 'No upload in progress for this document');
    this.assertDocAccess(actor, doc);
    const { key, fileName, contentType } = doc.pending;
    const bytes = await this.d.blob.read(key);
    if (!bytes) throw new HttpError(400, 'The file did not arrive. Please try again.', 'file_missing');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const items = this.checklist(claim);

    // Same file already uploaded for this claim, by anyone: do not ask for it twice.
    const dup = (await this.repo.listDocs(claimId)).find((d) => d.docId !== docId && d.status === 'uploaded' && d.sha256 === sha256);
    if (dup) {
      await this.d.blob.remove(key);
      doc.pending = undefined;
      if (doc.version === 0) await this.repo.delDoc(claimId, docId);
      else await this.repo.putDoc(doc);
      const label = items.find((i) => i.slot === dup.slot)?.label ?? 'another document';
      await this.audit(claimId, this.who(actor), 'duplicate_blocked', fileName);
      throw new HttpError(409, `This file has already been uploaded as "${label}". You do not need to upload it again.`, 'duplicate', { slot: dup.slot });
    }

    const c = await this.d.classifier.classify({ bytes, contentType, fileName, slots: items });
    doc.classification = {
      ...c,
      mismatch: c.detectedSlot !== 'unknown' && c.detectedSlot !== doc.slot && c.confidence >= 0.6,
    };
    Object.assign(doc, {
      fileName,
      contentType,
      size: bytes.length,
      sha256,
      s3Key: key,
      version: doc.version + 1,
      status: 'uploaded',
      uploadedBy: this.who(actor),
      uploadedAt: this.iso(),
      verification: 'not_started',
      verificationRef: undefined,
      verificationNote: undefined,
      pending: undefined,
    });
    await this.repo.putDoc(doc);
    await this.audit(claimId, this.who(actor), doc.version > 1 ? 'document_replaced' : 'document_uploaded', `${doc.slot}: ${fileName}`);
    await this.afterDocChange(claimId);
    return this.docForActor(actor, doc);
  }

  async downloadUrl(actor: Principal, claimId: string, docId: string) {
    await this.mustClaim(claimId);
    this.assertClaimAccess(actor, claimId);
    const doc = await this.repo.getDoc(claimId, docId);
    if (!doc || !doc.s3Key) throw new HttpError(404, 'Document not found');
    this.assertDocAccess(actor, doc);
    await this.audit(claimId, this.who(actor), 'document_downloaded', doc.fileName);
    return { url: await this.d.blob.presignDownload(doc.s3Key, doc.fileName), fileName: doc.fileName };
  }

  /** Marks step 3 done when the checklist is complete, then hands the documents to GreenID. */
  private async afterDocChange(claimId: string) {
    const claim = await this.mustClaim(claimId);
    const claimants = await this.repo.listClaimants(claimId);
    const docs = await this.repo.listDocs(claimId);
    const required = this.requiredEntries(claim, claimants.map((c) => c.claimantId)).filter((e) => !e.item.optional);
    const complete = required.every((e) => this.slotSatisfied(this.findDoc(docs, e.item.slot, e.claimantId)));
    const steps = deriveSteps(await this.loadSteps(claimId), claimId);
    const family = steps[2]!.state.owners.family?.status;
    if (!complete) {
      if (family === 'done') await this.mutateStep(claimId, 3, 'family', 'pending', undefined, 'system');
      return;
    }
    if (family !== 'done') await this.mutateStep(claimId, 3, 'family', 'done', undefined, 'system');
    const toVerify = docs.filter((d) => d.status === 'uploaded' && d.verification !== 'verified');
    if (toVerify.length === 0) return;
    for (const d of toVerify) {
      d.verification = 'pending';
      await this.repo.putDoc(d);
    }
    if (steps[3]!.state.owners.system?.status === 'done') await this.mutateStep(claimId, 4, 'system', 'pending', undefined, 'system');
    await this.audit(claimId, 'system', 'sent_to_greenid', `${toVerify.length} document(s)`);
    await this.d.startVerification(claimId);
  }

  /** Runs in the verification workflow. */
  async verifyClaim(claimId: string) {
    const claim = await this.mustClaim(claimId);
    const items = this.checklist(claim);
    const docs = (await this.repo.listDocs(claimId)).filter((d) => d.status === 'uploaded' && d.verification === 'pending');
    const failed: string[] = [];
    for (const d of docs) {
      const r = await this.d.greenId.verify({ fileName: d.fileName, sha256: d.sha256 ?? '', slot: d.slot });
      d.verification = r.result;
      d.verificationRef = r.reference;
      d.verificationNote = r.note;
      await this.repo.putDoc(d);
      await this.audit(claimId, 'greenid', `document_${r.result}`, `${d.fileName} (${r.reference})`);
      if (r.result === 'failed') failed.push(items.find((i) => i.slot === d.slot)?.label ?? d.slot);
    }
    if (failed.length) {
      await this.mutateStep(claimId, 3, 'family', 'blocked', `We could not verify: ${failed.join(', ')}. Please upload a clearer copy.`, 'greenid');
      return;
    }
    const all = await this.repo.listDocs(claimId);
    if (all.length && all.every((d) => d.status !== 'uploaded' || d.verification === 'verified')) {
      const steps = deriveSteps(await this.loadSteps(claimId), claimId);
      if (steps[2]!.status === 'completed') await this.mutateStep(claimId, 4, 'system', 'done', undefined, 'greenid');
    }
  }

  // ---------- Access checks ----------

  private assertClaimAccess(actor: Principal, claimId: string) {
    if (actor.kind === 'family' && actor.claimId !== claimId) throw new HttpError(403, 'Not allowed');
  }
  private assertDocAccess(actor: Principal, doc: DocRecord) {
    if (actor.kind === 'family' && doc.claimantId !== null && doc.claimantId !== actor.claimantId) throw new HttpError(403, 'Not allowed');
  }
  private docForActor(actor: Principal, d: DocRecord) {
    if (actor.kind === 'staff') return d;
    return { docId: d.docId, slot: d.slot, fileName: d.fileName, verification: d.verification };
  }

  // ---------- Views ----------

  async estimate(states: StepState[], claimId: string): Promise<Estimate | null> {
    const remaining = deriveSteps(states, claimId).filter((s) => s.def.id >= 3 && s.status !== 'completed');
    let min = 0, avg = 0, max = 0, n = Infinity;
    for (const s of remaining) {
      const stats = await this.repo.listStats(s.def.id);
      if (!stats.length) continue;
      const days = stats.map((x) => x.days);
      min += Math.min(...days);
      avg += days.reduce((a, b) => a + b, 0) / days.length;
      max += Math.max(...days);
      n = Math.min(n, days.length);
    }
    if (!Number.isFinite(n)) return null;
    const r = (x: number) => Math.round(x * 10) / 10;
    return { basedOnCases: n, remainingDays: { min: r(min), avg: r(avg), max: r(max) } };
  }

  async familyTracker(actor: Family): Promise<FamilyTracker> {
    const claim = await this.mustClaim(actor.claimId);
    const claimants = await this.repo.listClaimants(actor.claimId);
    if (!claimants.some((c) => c.claimantId === actor.claimantId)) throw new HttpError(403, 'Not allowed');
    const states = await this.loadSteps(actor.claimId);
    const derived = deriveSteps(states, actor.claimId);
    const steps: FamilyStepView[] = derived
      .filter((s) => !s.def.hiddenFromFamily)
      .map((s) => ({
        stepId: s.def.id,
        title: s.def.familyTitle,
        description: s.def.familyDescription,
        status: s.status === 'completed' ? 'done' : s.status === 'blocked' ? 'attention' : s.status === 'in_progress' ? 'current' : 'upcoming',
        waitingOn: s.status === 'completed' ? [] : s.pendingOwners,
        note: s.blockedOwners.map((o) => s.state.owners[o]?.note).find(Boolean),
      }));
    const docs = await this.repo.listDocs(actor.claimId);
    const checklist: ChecklistView[] = [];
    for (const item of this.checklist(claim)) {
      const claimantId = item.scope === 'claim' ? null : actor.claimantId;
      const d = this.findDoc(docs, item.slot, claimantId);
      checklist.push({
        ...item,
        claimantId,
        doc: d && d.status === 'uploaded' ? {
          docId: d.docId,
          fileName: d.fileName,
          uploadedAt: d.uploadedAt,
          uploadedByYou: d.uploadedBy === `family:${actor.claimantId}`,
          verification: d.verification,
          verificationNote: d.verificationNote,
          needsReview: !!d.classification?.mismatch,
        } : undefined,
      });
    }
    const requests = (await this.repo.listClaimRequests(actor.claimId)).filter((r) => r.claimantId === actor.claimantId);
    return {
      claim: { claimId: claim.claimId, deceasedName: claim.deceasedName, registeredAt: claim.createdAt },
      claimant: { claimantId: actor.claimantId, name: actor.name },
      steps,
      checklist,
      estimate: await this.estimate(states, actor.claimId),
      counsellingUrl: this.d.counsellingUrl,
      supportRequests: requests,
    };
  }

  async createSupportRequest(actor: Family, input: { phone?: unknown; preferredTime?: unknown; topic?: unknown }) {
    const r: SupportRequest = {
      requestId: randomBytes(5).toString('hex'),
      claimId: actor.claimId,
      claimantId: actor.claimantId,
      claimantName: actor.name,
      phone: text(input.phone, 'Phone number', 40),
      preferredTime: text(input.preferredTime, 'Preferred time', 100, false),
      topic: text(input.topic, 'What you would like help with', 500, false),
      status: 'open',
      createdAt: this.iso(),
    };
    await this.repo.putRequest(r);
    await this.audit(actor.claimId, this.who(actor), 'claim_specialist_requested');
    return r;
  }

  async listRequests(_actor: Staff) {
    return this.repo.listRequests();
  }
  async updateRequest(actor: Staff, claimId: string, requestId: string, status: unknown) {
    if (actor.party === 'tal') throw new HttpError(403, 'Only NGS or GROW handle claim specialist requests');
    if (status !== 'open' && status !== 'contacted' && status !== 'closed') throw new HttpError(400, 'Invalid status');
    const r = await this.repo.getRequest(claimId, requestId);
    if (!r) throw new HttpError(404, 'Request not found');
    r.status = status;
    r.updatedBy = this.who(actor);
    await this.repo.putRequest(r);
    await this.audit(claimId, this.who(actor), 'claim_specialist_request_updated', status);
    return r;
  }

  /** The time the last step completed. */
  private closedAt(derived: ReturnType<typeof deriveSteps>) {
    return derived.map((s) => s.state.completedAt ?? '').sort().pop() || undefined;
  }

  async listClaims(_actor: Staff): Promise<ClaimSummary[]> {
    const out: ClaimSummary[] = [];
    for (const claim of await this.repo.listClaims()) {
      const claimants = await this.repo.listClaimants(claim.claimId);
      const docs = await this.repo.listDocs(claim.claimId);
      const derived = deriveSteps(await this.loadSteps(claim.claimId), claim.claimId);
      const current = derived.find((s) => s.status !== 'completed');
      const required = this.requiredEntries(claim, claimants.map((c) => c.claimantId)).filter((e) => !e.item.optional);
      out.push({
        claim,
        claimantCount: claimants.length,
        currentStep: current ? { id: current.def.id, title: current.def.title, status: current.status } : null,
        waitingOn: current?.pendingOwners ?? [],
        closedAt: current ? undefined : this.closedAt(derived),
        docsRequired: required.length,
        docsReceived: required.filter((e) => this.slotSatisfied(this.findDoc(docs, e.item.slot, e.claimantId))).length,
      });
    }
    return out;
  }

  async staffClaimDetail(_actor: Staff, claimId: string): Promise<StaffClaimDetail> {
    const claim = await this.mustClaim(claimId);
    const claimants = await this.repo.listClaimants(claimId);
    const docs = await this.repo.listDocs(claimId);
    const derived = deriveSteps(await this.loadSteps(claimId), claimId);
    const checklist: StaffClaimDetail['checklist'] = [];
    for (const e of this.requiredEntries(claim, claimants.map((c) => c.claimantId))) {
      const d = this.findDoc(docs, e.item.slot, e.claimantId);
      checklist.push({ ...e.item, claimantId: e.claimantId, doc: d && (d.status === 'uploaded' || d.pending) ? d : undefined });
    }
    return {
      claim,
      closedAt: derived.every((s) => s.status === 'completed') ? this.closedAt(derived) : undefined,
      claimants: claimants.map(({ salt: _s, passcodeHash: _h, ...c }) => c),
      steps: derived.map((s) => ({
        stepId: s.def.id,
        title: s.def.title,
        status: s.status,
        owners: s.def.owners.map((o) => ({ owner: o, state: s.state.owners[o] ?? { status: 'pending' as const } })),
        completedAt: s.state.completedAt,
      })),
      checklist,
      audit: (await this.repo.listAudit(claimId)).slice(0, 100),
      supportRequests: await this.repo.listClaimRequests(claimId),
    };
  }
}

export type { Party };
