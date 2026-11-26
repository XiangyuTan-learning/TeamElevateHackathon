import type { Party } from '@claims/shared';
import type { Principal } from './auth';
import type { Repo } from './repo';
import type { Service } from './service';

const staff = (party: Party): Extract<Principal, { kind: 'staff' }> => ({ kind: 'staff', party, username: `${party}.seed` });

/** Synthetic history so the time estimate has data to work from. Step durations in days. */
export async function seedStats(repo: Repo, cases = 40) {
  const ranges: Record<number, [number, number]> = { 3: [2, 12], 4: [0.5, 3], 5: [5, 15], 6: [2, 8], 7: [1, 5], 8: [3, 10], 9: [2, 8] };
  for (let i = 0; i < cases; i++) {
    for (const [step, [lo, hi]] of Object.entries(ranges)) {
      const skew = Math.random() * Math.random(); // most cases are quicker than the worst case
      await repo.putStat({ stepId: Number(step), claimId: `HIST-${i}`, days: Math.round((lo + (hi - lo) * skew) * 10) / 10 });
    }
  }
}

async function upload(service: Service, who: Principal, claimId: string, slot: string, fileName: string, claimantId?: string, blob?: { write(k: string, d: Buffer, t: string): Promise<void> }) {
  const body = `%PDF-1.4 demo ${slot} ${claimantId ?? 'shared'} ${claimId} ${fileName}`;
  const variant = ({ deceased_id: 'passport', claimant_id: 'drivers_licence', probate: 'probate' } as Record<string, string>)[slot];
  const init = await service.initUpload(who, claimId, { slot, variant, claimantId, fileName, contentType: 'application/pdf', size: body.length });
  await blob!.write(init.key, Buffer.from(body), 'application/pdf');
  await service.completeUpload(who, claimId, init.docId);
}

/** Three demo claims at different stages. Prints the sign-in details for the family portal. */
/** Moves a claim's timestamps back in time, so demos can show claims that are already over their SLA. */
export async function backdateClaim(repo: Repo, claimId: string, days: number) {
  const ms = days * 86400000;
  const shift = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - ms).toISOString() : iso);
  const claim = (await repo.getClaim(claimId))!;
  await repo.putClaim({ ...claim, createdAt: shift(claim.createdAt)! });
  for (const s of await repo.listSteps(claimId)) {
    for (const o of Object.values(s.owners)) if (o?.updatedAt) o.updatedAt = shift(o.updatedAt);
    await repo.putStep({ ...s, completedAt: shift(s.completedAt) });
  }
}

export async function seedDemoClaims(service: Service, blob: { write(k: string, d: Buffer, t: string): Promise<void> }, opts: { repo?: Repo; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const grow = staff('grow'), ngs = staff('ngs'), tal = staff('tal');
  const address = { line1: '12 Wattle Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' };
  const make = async (name: string, claimants: { name: string; relationship: string }[]) =>
    service.createClaim(grow, { deceasedName: name, memberNumber: String(10000000 + Math.floor(Math.random() * 89999999)), claimants: claimants.map((c) => ({ ...c, address })) });

  // 1. Just registered, nothing uploaded yet. Dave is the main character in the pitch, so he is the first claimant.
  // Change MAIN_SURNAME to use his real surname.
  const MAIN_SURNAME = 'Mitchell';
  const a = await make(`Robert ${MAIN_SURNAME}`, [
    { name: `Dave ${MAIN_SURNAME}`, relationship: 'Son' },
    { name: `Sarah ${MAIN_SURNAME}`, relationship: 'Daughter' },
  ]);
  // 2. Documents verified, TAL has finished its part of assessment
  const b = await make('Margaret Liu', [{ name: 'David Liu', relationship: 'Son' }, { name: 'Emily Liu', relationship: 'Daughter' }]);
  const bId = b.claim.claimId;
  const fam = (i: number): Principal => ({ kind: 'family', claimId: bId, claimantId: b.claimants[i]!.claimantId, name: b.claimants[i]!.name });
  await upload(service, fam(0), bId, 'death_certificate', 'death-certificate.pdf', undefined, blob);
  await upload(service, fam(0), bId, 'deceased_id', 'deceased-passport.pdf', undefined, blob);
  for (const i of [0, 1]) {
    const cid = b.claimants[i]!.claimantId;
    await upload(service, fam(i), bId, 'claimant_id', `drivers-licence-${i}.pdf`, cid, blob);
    await upload(service, fam(i), bId, 'death_claim_form', `death-claim-form-${i}.pdf`, cid, blob);
    await upload(service, fam(i), bId, 'bank_statement', `bank-statement-${i}.pdf`, cid, blob);
  }
  await service.verifyClaim(bId);
  await service.staffStepAction(tal, bId, 5, 'done', 'Insurance cover confirmed');
  // 3. Documents collected, one failed GreenID so the family is asked to re-upload
  const c = await make('Peter Nakamura', [{ name: 'Yuki Nakamura', relationship: 'Spouse' }]);
  const cId = c.claim.claimId;
  const f: Principal = { kind: 'family', claimId: cId, claimantId: 'C1', name: 'Yuki Nakamura' };
  await upload(service, f, cId, 'death_certificate', 'death-certificate.pdf', undefined, blob);
  await upload(service, f, cId, 'deceased_id', 'deceased-medicare.pdf', undefined, blob);
  await upload(service, f, cId, 'claimant_id', 'passport-blurry.pdf', 'C1', blob);
  await upload(service, f, cId, 'death_claim_form', 'death-claim-form.pdf', 'C1', blob);
  await upload(service, f, cId, 'bank_statement', 'bank-statement.pdf', 'C1', blob);
  await service.verifyClaim(cId);
  // Open for 16 days against a 14 day documents SLA, so the claim list shows a breach.
  if (opts.repo) await backdateClaim(opts.repo, cId, 16);

  log('\nDemo claims (family portal sign-in):');
  for (const x of [a, b, c]) for (const cl of x.claimants) log(`  ${x.claim.claimId}  passcode ${cl.passcode}  (${cl.name}, claim for ${x.claim.deceasedName})`);
  void ngs;
}
