import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Party } from '@claims/shared';
import type { Principal } from '../src/auth';
import { MemoryBlob } from '../src/blob';
import { FilenameClassifier } from '../src/classifier';
import { MockGreenId } from '../src/greenid';
import { MemoryKV } from '../src/kv';
import { Repo } from '../src/repo';
import { seedStats } from '../src/seed-data';
import { HttpError, Service } from '../src/service';

const staff = (party: Party): Extract<Principal, { kind: 'staff' }> => ({ kind: 'staff', party, username: 'test' });
let service: Service, repo: Repo, blob: MemoryBlob, verifyQueue: string[];

beforeEach(() => {
  repo = new Repo(new MemoryKV());
  blob = new MemoryBlob('http://x');
  verifyQueue = [];
  service = new Service({
    repo, blob, classifier: new FilenameClassifier(), greenId: new MockGreenId(), counsellingUrl: 'http://c',
    startVerification: async (id) => void verifyQueue.push(id),
  });
});

const ADDR = { line1: '12 Wattle Street', line2: 'Unit 3', suburb: 'Parramatta', state: 'NSW', postcode: '2150' };
const DEFAULT_VARIANT: Record<string, string> = { deceased_id: 'passport', claimant_id: 'drivers_licence', probate: 'probate' };
async function upload(who: Principal, claimId: string, slot: string, fileName: string, content: string, claimantId?: string, variant = DEFAULT_VARIANT[slot]) {
  const init = await service.initUpload(who, claimId, { slot, variant, claimantId, fileName, contentType: 'application/pdf', size: content.length });
  await blob.write(init.key, Buffer.from(content), 'application/pdf');
  return service.completeUpload(who, claimId, init.docId);
}
const rejects = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status);

async function newClaim(n = 1) {
  const r = await service.createClaim(staff('grow'), {
    deceasedName: 'Test Member',
    claimants: Array.from({ length: n }, (_, i) => ({ name: `Claimant ${i + 1}`, relationship: 'Child', address: ADDR })),
  });
  const fam = (i: number): Extract<Principal, { kind: 'family' }> => ({ kind: 'family', claimId: r.claim.claimId, claimantId: r.claimants[i]!.claimantId, name: r.claimants[i]!.name });
  return { ...r, id: r.claim.claimId, fam };
}
async function completeDocs(c: Awaited<ReturnType<typeof newClaim>>) {
  await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
  await upload(c.fam(0), c.id, 'deceased_id', 'deceased-passport.pdf', 'did');
  for (let i = 0; i < c.claimants.length; i++) await uploadClaimantDocs(c, i);
}
async function uploadClaimantDocs(c: Awaited<ReturnType<typeof newClaim>>, i: number) {
  await upload(c.fam(i), c.id, 'claimant_id', 'licence.pdf', `id${i}`);
  await upload(c.fam(i), c.id, 'death_claim_form', 'claim-form.pdf', `form${i}`);
  await upload(c.fam(i), c.id, 'bank_statement', 'bank-statement.pdf', `bank${i}`);
}

describe('claims', () => {
  it('only GROW registers claims, and steps 1 and 2 start complete', async () => {
    await rejects(service.createClaim(staff('tal'), { deceasedName: 'x', claimants: [{ name: 'a', relationship: 'b' }] }), 403);
    const c = await newClaim();
    const d = await service.staffClaimDetail(staff('ngs'), c.id);
    assert.deepEqual(d.steps.slice(0, 3).map((s) => s.status), ['completed', 'completed', 'in_progress']);
  });

  it('reports the current step with its SLA and when it started', async () => {
    const c = await newClaim();
    let [row] = await service.listClaims(staff('tal'));
    assert.equal(row!.currentStep!.id, 3);
    assert.equal(row!.currentStep!.slaDays, 14);
    assert.equal(row!.currentStep!.startedAt, c.claim.createdAt);
    await completeDocs(c);
    await service.verifyClaim(c.id);
    [row] = await service.listClaims(staff('tal'));
    assert.equal(row!.currentStep!.id, 5);
    assert.equal(row!.currentStep!.slaDays, 10);
    const steps = (await service.staffClaimDetail(staff('tal'), c.id)).steps;
    assert.equal(row!.currentStep!.startedAt, steps[3]!.completedAt); // starts when step 4 completes
  });

  it('requires a valid Australian address for every claimant, and keeps it from TAL', async () => {
    const make = (address: unknown) => service.createClaim(staff('grow'), { deceasedName: 'M', claimants: [{ name: 'A', relationship: 'Son', address }] });
    await rejects(make(undefined), 400);
    await rejects(make({ ...ADDR, line1: '' }), 400);
    await rejects(make({ ...ADDR, suburb: '' }), 400);
    await rejects(make({ ...ADDR, state: 'XX' }), 400);
    await rejects(make({ ...ADDR, postcode: '21500' }), 400);
    await rejects(make({ ...ADDR, postcode: 'abcd' }), 400);
    const ok = await make({ ...ADDR, line2: '', state: 'nsw' }); // line 2 is optional, state is normalised
    const ngs = await service.staffClaimDetail(staff('ngs'), ok.claim.claimId);
    const a = ngs.claimants[0]!.address!;
    assert.deepEqual([a.line1, a.line2, a.suburb, a.state, a.postcode], [ADDR.line1, undefined, 'Parramatta', 'NSW', '2150']);
    const tal = await service.staffClaimDetail(staff('tal'), ok.claim.claimId);
    assert.equal(tal.claimants.length, 0); // TAL gets no claimant details at all
    await rejects(service.addClaimant(staff('ngs'), ok.claim.claimId, { name: 'B', relationship: 'Son' }), 400); // addresses are required when adding too
  });

  it('lets NGS register a claim as well as GROW, but not TAL', async () => {
    const input = { deceasedName: 'M', claimants: [{ name: 'A', relationship: 'Son', address: ADDR }] };
    const r = await service.createClaim(staff('ngs'), input);
    assert.match((await service.staffClaimDetail(staff('grow'), r.claim.claimId)).claim.createdBy, /^ngs:/);
    await rejects(service.createClaim(staff('tal'), input), 403);
  });

  it('feeds each claimant a share of the benefit that adds up to 100, without staff typing it in', async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) { // 6 is the most a claim can start with. 5 and 6 use the equal-split fallback
      const c = await newClaim(n);
      const shares = (await service.staffClaimDetail(staff('ngs'), c.id)).claimants.map((x) => x.allocationPercent!);
      assert.ok(shares.every((s) => Number.isInteger(s) && s > 0), `n=${n}`);
      assert.equal(shares.reduce((a, b) => a + b, 0), 100, `n=${n}`);
    }
    const c = await newClaim(1);
    await service.addClaimant(staff('ngs'), c.id, { name: 'B', relationship: 'Son', address: ADDR });
    const shares = (await service.staffClaimDetail(staff('ngs'), c.id)).claimants.map((x) => x.allocationPercent);
    assert.deepEqual(shares, [60, 40]); // re-split when someone is added
  });

  it('hides claimants and claim specialist requests from TAL, and gives NGS and GROW the same request queue', async () => {
    const c = await newClaim(2);
    const req = await service.createSupportRequest(c.fam(0), { phone: '0400 000 000' });
    const tal = await service.staffClaimDetail(staff('tal'), c.id);
    assert.equal(tal.claimants.length, 0);
    assert.equal(tal.supportRequests.length, 0);
    assert.equal((await service.listClaims(staff('tal')))[0]!.claimantCount, 0);
    await rejects(service.listRequests(staff('tal')), 403);
    await rejects(service.updateRequest(staff('tal'), c.id, req.requestId, 'contacted'), 403);
    assert.ok(tal.audit.every((a) => !/claim_specialist|claimant_added|passcode/.test(a.action)));
    for (const party of ['ngs', 'grow'] as Party[]) assert.equal((await service.listRequests(staff(party))).length, 1);
  });

  it('lets the family change or cancel a claim specialist request until someone has been in touch', async () => {
    const c = await newClaim(2);
    const req = await service.createSupportRequest(c.fam(0), { phone: '0400 000 000', preferredTime: 'mornings', topic: 'Not sure what to upload' });
    const edited = await service.editSupportRequest(c.fam(0), req.requestId, { phone: '0411 111 111', preferredTime: 'after 3pm', topic: 'Bank statement question' });
    assert.deepEqual([edited.phone, edited.preferredTime, edited.topic], ['0411 111 111', 'after 3pm', 'Bank statement question']);
    assert.ok(edited.editedAt);
    // The staff request list sees the change.
    const seen = (await service.listRequests(staff('ngs')))[0]!;
    assert.equal(seen.phone, '0411 111 111');
    assert.ok(seen.editedAt);
    await rejects(service.editSupportRequest(c.fam(1), req.requestId, { phone: '0422 222 222' }), 404); // another claimant's request
    await rejects(service.editSupportRequest(c.fam(0), req.requestId, { phone: '' }), 400);
    // Cancel
    const gone = await service.cancelSupportRequest(c.fam(0), req.requestId);
    assert.equal(gone.status, 'cancelled');
    assert.equal((await service.listRequests(staff('grow')))[0]!.status, 'cancelled');
    await rejects(service.updateRequest(staff('ngs'), c.id, req.requestId, 'contacted'), 409);
    await rejects(service.editSupportRequest(c.fam(0), req.requestId, { phone: '0400 000 000' }), 409);
    // Once staff have called, the family can no longer change or cancel it.
    const second = await service.createSupportRequest(c.fam(0), { phone: '0400 000 000' });
    await service.updateRequest(staff('grow'), c.id, second.requestId, 'contacted');
    await rejects(service.editSupportRequest(c.fam(0), second.requestId, { phone: '0433 333 333' }), 409);
    await rejects(service.cancelSupportRequest(c.fam(0), second.requestId), 409);
    const audit = (await service.staffClaimDetail(staff('ngs'), c.id)).audit.map((a) => a.action);
    assert.ok(audit.includes('claim_specialist_request_edited') && audit.includes('claim_specialist_request_cancelled'));
    assert.ok((await service.staffClaimDetail(staff('tal'), c.id)).audit.every((a) => !a.action.startsWith('claim_specialist')));
  });

  it('lets NGS and GROW edit a claimant but not TAL, and keeps the share fixed', async () => {
    const c = await newClaim(2);
    const req = await service.createSupportRequest(c.fam(0), { phone: '0400 000 000' });
    const before = (await service.staffClaimDetail(staff('ngs'), c.id)).claimants[0]!;
    const next = { name: 'Claimant One Renamed', relationship: 'Daughter', email: 'new@example.com', phone: '0400 123 456', address: { ...ADDR, line1: '99 New Road', postcode: '3000', state: 'VIC' } };
    await rejects(service.updateClaimant(staff('tal'), c.id, 'C1', next), 403);
    await rejects(service.updateClaimant(staff('ngs'), c.id, 'C1', { ...next, name: '' }), 400);
    await rejects(service.updateClaimant(staff('ngs'), c.id, 'C1', { ...next, address: { ...next.address, postcode: '30' } }), 400);
    await rejects(service.updateClaimant(staff('ngs'), c.id, 'C9', next), 404);
    const done = await service.updateClaimant(staff('grow'), c.id, 'C1', { ...next, allocationPercent: 99 } as typeof next);
    assert.equal(done.name, 'Claimant One Renamed');
    assert.equal(done.address!.state, 'VIC');
    assert.equal(done.allocationPercent, before.allocationPercent); // fed by the allocation service, not editable
    assert.equal((await service.familyTracker(c.fam(0))).claimant.name, 'Claimant One Renamed');
    assert.equal((await service.listRequests(staff('ngs')))[0]!.claimantName, 'Claimant One Renamed'); // request follows the new name
    void req;
    const log = (await service.staffClaimDetail(staff('ngs'), c.id)).audit.find((a) => a.action === 'claimant_updated')!;
    assert.equal(log.actor, 'grow:test');
    assert.match(log.detail ?? '', /name, relationship, email, phone, address/);
    await service.familyLogin(c.id, c.claimants[0]!.passcode); // sign-in still works after an edit
  });

  it('records who made the call and when, and which party did each thing in the activity log', async () => {
    const c = await newClaim();
    const req = await service.createSupportRequest(c.fam(0), { phone: '0400 000 000' });
    const done = await service.updateRequest(staff('ngs'), c.id, req.requestId, 'contacted');
    assert.equal(done.contactedBy, 'ngs:test');
    assert.ok(done.contactedAt);
    const audit = (await service.staffClaimDetail(staff('grow'), c.id)).audit;
    const asked = audit.find((a) => a.action === 'claim_specialist_requested')!;
    const called = audit.find((a) => a.action === 'claim_specialist_request_updated')!;
    assert.equal(asked.actor, 'family:C1');
    assert.equal(asked.detail, 'Claimant 1');
    assert.equal(called.actor, 'ngs:test');
    assert.equal(called.detail, 'Claimant 1: contacted');
    assert.ok(asked.at && called.at);
  });

  it('family sign-in needs the passcode and locks after repeated failures', async () => {
    const c = await newClaim();
    const ok = await service.familyLogin(c.id.toLowerCase(), c.claimants[0]!.passcode.toLowerCase().replace('-', ' '));
    assert.equal(ok.claimantId, 'C1');
    for (let i = 0; i < 8; i++) await rejects(service.familyLogin(c.id, 'WRONG-CODE'), 401);
    await rejects(service.familyLogin(c.id, c.claimants[0]!.passcode), 429);
  });
});

describe('documents', () => {
  it('blocks the same file being uploaded twice and tells the family where it is', async () => {
    const c = await newClaim();
    await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'same-bytes');
    await assert.rejects(upload(c.fam(0), c.id, 'claimant_id', 'copy.pdf', 'same-bytes'), /already been uploaded as "Death certificate"/);
  });

  it('shares claim-level documents between claimants and keeps claimant documents private', async () => {
    const c = await newClaim(2);
    const dc = await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
    const own = await upload(c.fam(0), c.id, 'claimant_id', 'licence.pdf', 'id0');
    const t = await service.familyTracker(c.fam(1));
    assert.equal(t.checklist.find((i) => i.slot === 'death_certificate')?.doc?.docId, dc.docId);
    assert.equal(t.checklist.find((i) => i.slot === 'claimant_id')?.doc, undefined);
    await service.downloadUrl(c.fam(1), c.id, dc.docId);
    await rejects(service.downloadUrl(c.fam(1), c.id, own.docId), 403);
  });

  it('needs the type chosen for ID and probate documents, and one ID of any type is enough', async () => {
    const c = await newClaim();
    const base = { slot: 'deceased_id', fileName: 'x.pdf', contentType: 'application/pdf', size: 3 };
    await rejects(service.initUpload(c.fam(0), c.id, base), 400); // no type chosen
    await rejects(service.initUpload(c.fam(0), c.id, { ...base, variant: 'library_card' }), 400);
    await upload(c.fam(0), c.id, 'deceased_id', 'medicare.pdf', 'm', undefined, 'medicare');
    const t = await service.familyTracker(c.fam(0));
    const row = t.checklist.find((i) => i.slot === 'deceased_id')!;
    assert.equal(row.doc?.variant, 'medicare');
    // One ID document fills the slot. Replacing it with another type keeps a single document.
    await upload(c.fam(0), c.id, 'deceased_id', 'passport.pdf', 'p', undefined, 'passport');
    const d = await service.staffClaimDetail(staff('ngs'), c.id);
    assert.equal(d.checklist.filter((i) => i.slot === 'deceased_id').length, 1);
    assert.equal(d.checklist.find((i) => i.slot === 'deceased_id')!.doc!.variant, 'passport');
    await rejects(service.initUpload(c.fam(0), c.id, { slot: 'probate', fileName: 'p.pdf', contentType: 'application/pdf', size: 3 }), 400);
  });

  it('counts five required documents for one claimant, and optional ones do not block step 3', async () => {
    const c = await newClaim();
    assert.equal((await service.listClaims(staff('ngs')))[0]!.docsRequired, 5);
    await completeDocs(c);
    assert.equal((await service.staffClaimDetail(staff('ngs'), c.id)).steps[2]!.status, 'completed'); // no probate, will or court order
    await upload(c.fam(0), c.id, 'will', 'will.pdf', 'w');
    await upload(c.fam(0), c.id, 'court_order', 'court-order.pdf', 'co');
    assert.equal((await service.staffClaimDetail(staff('ngs'), c.id)).checklist.length, 8);
  });

  it('lets NGS and GROW see every document but TAL only the death certificate and the deceased ID', async () => {
    const c = await newClaim();
    await completeDocs(c);
    const bank = (await service.staffClaimDetail(staff('ngs'), c.id)).checklist.find((i) => i.slot === 'bank_statement')!.doc!;
    const dc = (await service.staffClaimDetail(staff('tal'), c.id)).checklist.find((i) => i.slot === 'death_certificate')!.doc!;
    for (const party of ['ngs', 'grow'] as Party[]) {
      assert.equal((await service.staffClaimDetail(staff(party), c.id)).checklist.length, 8); // all eight, for a single claimant
      await service.downloadUrl(staff(party), c.id, bank.docId);
    }
    const tal = await service.staffClaimDetail(staff('tal'), c.id);
    assert.deepEqual(tal.checklist.map((i) => i.slot), ['death_certificate', 'deceased_id']);
    await service.downloadUrl(staff('tal'), c.id, dc.docId);
    await rejects(service.downloadUrl(staff('tal'), c.id, bank.docId), 403);
    await rejects(service.initUpload(staff('tal'), c.id, { slot: 'bank_statement', claimantId: 'C1', fileName: 'b.pdf', contentType: 'application/pdf', size: 3 }), 403);
    assert.ok(tal.audit.every((a) => !/bank_statement|claimant_id|death_claim_form/.test(a.detail ?? ''))); // no leaks through the activity log
    assert.equal((await service.listClaims(staff('tal')))[0]!.docsRequired, 2);
  });

  it('shows the member number to the family', async () => {
    const r = await service.createClaim(staff('grow'), { deceasedName: 'M', memberNumber: '12345678', claimants: [{ name: 'A B', relationship: 'Son', address: ADDR }] });
    const t = await service.familyTracker({ kind: 'family', claimId: r.claim.claimId, claimantId: 'C1', name: 'A B' });
    assert.equal(t.claim.memberNumber, '12345678');
  });

  it('completes step 3 when every claimant has uploaded, then GreenID verifies and step 4 completes', async () => {
    const c = await newClaim(2);
    await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
    await upload(c.fam(0), c.id, 'deceased_id', 'deceased-passport.pdf', 'did');
    await uploadClaimantDocs(c, 0);
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[2]!.status, 'in_progress'); // second claimant still to upload
    await uploadClaimantDocs(c, 1);
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[2]!.status, 'completed');
    assert.ok(verifyQueue.includes(c.id));
    await service.verifyClaim(c.id);
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[3]!.status, 'completed');
  });

  it('asks the family to re-upload a document GreenID rejects, then recovers', async () => {
    const c = await newClaim();
    await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
    await upload(c.fam(0), c.id, 'deceased_id', 'deceased-passport.pdf', 'did');
    await upload(c.fam(0), c.id, 'claimant_id', 'licence-blurry.pdf', 'id');
    await upload(c.fam(0), c.id, 'death_claim_form', 'claim-form.pdf', 'form');
    await upload(c.fam(0), c.id, 'bank_statement', 'bank-statement.pdf', 'bank');
    await service.verifyClaim(c.id);
    let t = await service.familyTracker(c.fam(0));
    assert.equal(t.steps[0]!.status, 'attention');
    assert.match(t.steps[0]!.note ?? '', /Proof of ID for the claimant/);
    await upload(c.fam(0), c.id, 'claimant_id', 'licence-clear.pdf', 'id-new');
    await service.verifyClaim(c.id);
    t = await service.familyTracker(c.fam(0));
    assert.deepEqual(t.steps.slice(0, 2).map((s) => s.status), ['done', 'done']);
  });
});

describe('steps with several owners', () => {
  async function atAssessment() {
    const c = await newClaim();
    await completeDocs(c);
    await service.verifyClaim(c.id);
    return c;
  }

  it('enforces ownership and completes a step only when every owner is done', async () => {
    const c = await atAssessment();
    await rejects(service.staffStepAction(staff('grow'), c.id, 6, 'done', ''), 403); // only TAL owns step 6
    await rejects(service.staffStepAction(staff('ngs'), c.id, 6, 'done', ''), 403); // NGS cannot mark the insurer decision
    await rejects(service.staffStepAction(staff('tal'), c.id, 6, 'done', ''), 409); // locked until step 5 completes
    await service.staffStepAction(staff('tal'), c.id, 5, 'done', '');
    await service.staffStepAction(staff('ngs'), c.id, 5, 'done', '');
    let d = await service.staffClaimDetail(staff('ngs'), c.id);
    assert.equal(d.steps[4]!.status, 'in_progress');
    await rejects(service.staffStepAction(staff('tal'), c.id, 6, 'done', ''), 409);
    await service.staffStepAction(staff('grow'), c.id, 5, 'done', '');
    d = await service.staffClaimDetail(staff('ngs'), c.id);
    assert.equal(d.steps[4]!.status, 'completed');
    assert.equal(d.steps[5]!.status, 'in_progress');
  });

  it('runs insurer decision, TAL payment (both TAL), trustee decision (NGS), then outcome and payment (GROW)', async () => {
    const c = await atAssessment();
    for (const p of ['tal', 'ngs', 'grow'] as Party[]) await service.staffStepAction(staff(p), c.id, 5, 'done', '');
    await rejects(service.staffStepAction(staff('tal'), c.id, 7, 'done', ''), 409); // payment waits for the insurer decision
    await service.staffStepAction(staff('tal'), c.id, 6, 'done', '');
    await rejects(service.staffStepAction(staff('ngs'), c.id, 7, 'done', ''), 403); // only TAL handles TAL payment
    await rejects(service.staffStepAction(staff('ngs'), c.id, 8, 'done', ''), 409); // trustee waits for TAL payment
    await service.staffStepAction(staff('tal'), c.id, 7, 'done', '');
    await service.staffStepAction(staff('ngs'), c.id, 8, 'done', '');
    await rejects(service.staffStepAction(staff('ngs'), c.id, 9, 'done', ''), 403); // NGS does not own the final step
    await service.staffStepAction(staff('grow'), c.id, 9, 'done', '');
    const d = await service.staffClaimDetail(staff('grow'), c.id);
    assert.ok(d.closedAt);
    assert.equal(d.steps.length, 9);
  });

  it('shows TAL steps 1 to 7 only, while NGS and GROW see all nine', async () => {
    const c = await atAssessment();
    for (const p of ['ngs', 'grow'] as Party[]) assert.equal((await service.staffClaimDetail(staff(p), c.id)).steps.length, 9);
    let tal = await service.staffClaimDetail(staff('tal'), c.id);
    assert.deepEqual(tal.steps.map((s) => s.stepId), [1, 2, 3, 4, 5, 6, 7]);
    for (const p of ['tal', 'ngs', 'grow'] as Party[]) await service.staffStepAction(staff(p), c.id, 5, 'done', '');
    await service.staffStepAction(staff('tal'), c.id, 6, 'done', '');
    await service.staffStepAction(staff('tal'), c.id, 7, 'done', '');
    await service.staffStepAction(staff('ngs'), c.id, 8, 'done', 'Approved for payment'); // a step TAL cannot see
    // TAL has finished everything it can see: its clock stops and it is told so, while the claim stays open for NGS.
    tal = await service.staffClaimDetail(staff('tal'), c.id);
    assert.ok(tal.closedAt);
    const [row] = await service.listClaims(staff('tal'));
    assert.equal(row!.currentStep, null);
    assert.equal(row!.stepLimit, 7);
    assert.equal((await service.staffClaimDetail(staff('ngs'), c.id)).closedAt, undefined);
    assert.equal((await service.listClaims(staff('ngs')))[0]!.currentStep!.id, 9);
    // TAL cannot act on, or learn about, steps beyond 7.
    await rejects(service.staffStepAction(staff('tal'), c.id, 9, 'done', ''), 404);
    assert.ok(tal.audit.every((a) => !/Trustee decision|Approved for payment/.test(a.detail ?? '')));
    assert.ok((await service.staffClaimDetail(staff('ngs'), c.id)).audit.some((a) => /Trustee decision/.test(a.detail ?? '')));
  });

  it('a blocked owner shows to the family, and reopen is refused once the next step is complete', async () => {
    const c = await atAssessment();
    await rejects(service.staffStepAction(staff('tal'), c.id, 5, 'block', ''), 400);
    await service.staffStepAction(staff('tal'), c.id, 5, 'block', 'Need a medical report');
    const t = await service.familyTracker(c.fam(0));
    assert.equal(t.steps.find((s) => s.stepId === 5)!.status, 'attention');
    for (const p of ['tal', 'ngs', 'grow'] as Party[]) await service.staffStepAction(staff(p), c.id, 5, 'done', '');
    await service.staffStepAction(staff('tal'), c.id, 6, 'done', '');
    await rejects(service.staffStepAction(staff('tal'), c.id, 5, 'reopen', ''), 409); // next step is complete
    await service.staffStepAction(staff('tal'), c.id, 6, 'reopen', '');
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[5]!.status, 'in_progress');
  });

  it('records durations when the claim finishes and uses them for the estimate', async () => {
    await seedStats(repo, 10);
    const c = await atAssessment();
    const before = (await service.familyTracker(c.fam(0))).estimate!;
    assert.ok(before.remainingDays.min <= before.remainingDays.avg && before.remainingDays.avg <= before.remainingDays.max);
    for (const [step, parties] of [[5, ['tal', 'ngs', 'grow']], [6, ['tal']], [7, ['tal']], [8, ['ngs']], [9, ['grow']]] as [number, Party[]][])
      for (const p of parties) await service.staffStepAction(staff(p), c.id, step, 'done', '');
    assert.equal((await service.familyTracker(c.fam(0))).estimate, null);
    assert.equal((await repo.listStats(9)).filter((s) => s.claimId === c.id).length, 1);
  });
});
