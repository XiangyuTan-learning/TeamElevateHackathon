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

async function upload(who: Principal, claimId: string, slot: string, fileName: string, content: string, claimantId?: string) {
  const init = await service.initUpload(who, claimId, { slot, claimantId, fileName, contentType: 'application/pdf', size: content.length });
  await blob.write(init.key, Buffer.from(content), 'application/pdf');
  return service.completeUpload(who, claimId, init.docId);
}
const rejects = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status);

async function newClaim(n = 1) {
  const r = await service.createClaim(staff('grow'), {
    deceasedName: 'Test Member',
    claimants: Array.from({ length: n }, (_, i) => ({ name: `Claimant ${i + 1}`, relationship: 'Child' })),
  });
  const fam = (i: number): Extract<Principal, { kind: 'family' }> => ({ kind: 'family', claimId: r.claim.claimId, claimantId: r.claimants[i]!.claimantId, name: r.claimants[i]!.name });
  return { ...r, id: r.claim.claimId, fam };
}
async function completeDocs(c: Awaited<ReturnType<typeof newClaim>>) {
  await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
  for (let i = 0; i < c.claimants.length; i++) {
    await upload(c.fam(i), c.id, 'claimant_id', 'licence.pdf', `id${i}`);
    await upload(c.fam(i), c.id, 'relationship_proof', 'birth-cert.pdf', `rp${i}`);
  }
}

describe('claims', () => {
  it('only GROW registers claims, and steps 1 and 2 start complete', async () => {
    await rejects(service.createClaim(staff('tal'), { deceasedName: 'x', claimants: [{ name: 'a', relationship: 'b' }] }), 403);
    const c = await newClaim();
    const d = await service.staffClaimDetail(staff('ngs'), c.id);
    assert.deepEqual(d.steps.slice(0, 3).map((s) => s.status), ['completed', 'completed', 'in_progress']);
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

  it('completes step 3 when every claimant has uploaded, then GreenID verifies and step 4 completes', async () => {
    const c = await newClaim(2);
    await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
    await upload(c.fam(0), c.id, 'claimant_id', 'licence.pdf', 'id0');
    await upload(c.fam(0), c.id, 'relationship_proof', 'birth-cert.pdf', 'rp0');
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[2]!.status, 'in_progress'); // second claimant still to upload
    await upload(c.fam(1), c.id, 'claimant_id', 'licence.pdf', 'id1');
    await upload(c.fam(1), c.id, 'relationship_proof', 'birth-cert.pdf', 'rp1');
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[2]!.status, 'completed');
    assert.ok(verifyQueue.includes(c.id));
    await service.verifyClaim(c.id);
    assert.equal((await service.staffClaimDetail(staff('tal'), c.id)).steps[3]!.status, 'completed');
  });

  it('asks the family to re-upload a document GreenID rejects, then recovers', async () => {
    const c = await newClaim();
    await upload(c.fam(0), c.id, 'death_certificate', 'death-cert.pdf', 'dc');
    await upload(c.fam(0), c.id, 'claimant_id', 'licence-blurry.pdf', 'id');
    await upload(c.fam(0), c.id, 'relationship_proof', 'birth-cert.pdf', 'rp');
    await service.verifyClaim(c.id);
    let t = await service.familyTracker(c.fam(0));
    assert.equal(t.steps[0]!.status, 'attention');
    assert.match(t.steps[0]!.note ?? '', /Photo ID/);
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

  it('runs insurer decision (TAL), then trustee decision (NGS only), then outcome and payment (GROW and TAL)', async () => {
    const c = await atAssessment();
    for (const p of ['tal', 'ngs', 'grow'] as Party[]) await service.staffStepAction(staff(p), c.id, 5, 'done', '');
    await rejects(service.staffStepAction(staff('ngs'), c.id, 7, 'done', ''), 409); // trustee waits for the insurer
    await service.staffStepAction(staff('tal'), c.id, 6, 'done', '');
    await rejects(service.staffStepAction(staff('tal'), c.id, 7, 'done', ''), 403); // TAL is not a trustee
    await service.staffStepAction(staff('ngs'), c.id, 7, 'done', '');
    await rejects(service.staffStepAction(staff('ngs'), c.id, 8, 'done', ''), 403); // NGS does not own payment
    await service.staffStepAction(staff('grow'), c.id, 8, 'done', '');
    let d = await service.staffClaimDetail(staff('tal'), c.id);
    assert.equal(d.closedAt, undefined);
    await service.staffStepAction(staff('tal'), c.id, 8, 'done', '');
    d = await service.staffClaimDetail(staff('tal'), c.id);
    assert.ok(d.closedAt);
    assert.equal(d.steps.length, 8);
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
    for (const [step, parties] of [[5, ['tal', 'ngs', 'grow']], [6, ['tal']], [7, ['ngs']], [8, ['grow', 'tal']]] as [number, Party[]][])
      for (const p of parties) await service.staffStepAction(staff(p), c.id, step, 'done', '');
    assert.equal((await service.familyTracker(c.fam(0))).estimate, null);
    assert.equal((await repo.listStats(8)).filter((s) => s.claimId === c.id).length, 1);
  });
});
