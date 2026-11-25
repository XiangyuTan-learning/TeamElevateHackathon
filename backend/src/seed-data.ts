import type { Party } from '@claims/shared';
import type { Principal } from './auth';
import type { Repo } from './repo';
import type { Service } from './service';

const staff = (party: Party): Extract<Principal, { kind: 'staff' }> => ({ kind: 'staff', party, username: `${party}.seed` });

/** Synthetic history so the time estimate has data to work from. Step durations in days. */
export async function seedStats(repo: Repo, cases = 40) {
  const ranges: Record<number, [number, number]> = { 3: [2, 12], 4: [0.5, 3], 5: [5, 15], 6: [2, 8], 7: [3, 10], 8: [2, 8] };
  for (let i = 0; i < cases; i++) {
    for (const [step, [lo, hi]] of Object.entries(ranges)) {
      const skew = Math.random() * Math.random(); // most cases are quicker than the worst case
      await repo.putStat({ stepId: Number(step), claimId: `HIST-${i}`, days: Math.round((lo + (hi - lo) * skew) * 10) / 10 });
    }
  }
}

async function upload(service: Service, who: Principal, claimId: string, slot: string, fileName: string, claimantId?: string, blob?: { write(k: string, d: Buffer, t: string): Promise<void> }) {
  const body = `%PDF-1.4 demo ${slot} ${claimantId ?? 'shared'} ${claimId} ${fileName}`;
  const init = await service.initUpload(who, claimId, { slot, claimantId, fileName, contentType: 'application/pdf', size: body.length });
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
  const make = async (name: string, claimants: { name: string; relationship: string }[]) => (await service.createClaim(grow, { deceasedName: name, memberNumber: String(10000000 + Math.floor(Math.random() * 89999999)), claimants }));

  // 1. Just registered, nothing uploaded yet
  const a = await make('Robert Hargreaves', [{ name: 'Helen Hargreaves', relationship: 'Spouse' }]);
  // 2. Documents verified, TAL has finished its part of assessment
  const b = await make('Margaret Liu', [{ name: 'David Liu', relationship: 'Son' }, { name: 'Emily Liu', relationship: 'Daughter' }]);
  const bId = b.claim.claimId;
  const fam = (i: number): Principal => ({ kind: 'family', claimId: bId, claimantId: b.claimants[i]!.claimantId, name: b.claimants[i]!.name });
  await upload(service, fam(0), bId, 'death_certificate', 'death-certificate.pdf', undefined, blob);
  for (const i of [0, 1]) {
    await upload(service, fam(i), bId, 'claimant_id', `drivers-licence-${i}.pdf`, b.claimants[i]!.claimantId, blob);
    await upload(service, fam(i), bId, 'relationship_proof', `birth-certificate-${i}.pdf`, b.claimants[i]!.claimantId, blob);
  }
  await service.verifyClaim(bId);
  await service.staffStepAction(tal, bId, 5, 'done', 'Insurance cover confirmed');
  // 3. Documents collected, one failed GreenID so the family is asked to re-upload
  const c = await make('Peter Nakamura', [{ name: 'Yuki Nakamura', relationship: 'Spouse' }]);
  const cId = c.claim.claimId;
  const f: Principal = { kind: 'family', claimId: cId, claimantId: 'C1', name: 'Yuki Nakamura' };
  await upload(service, f, cId, 'death_certificate', 'death-certificate.pdf', undefined, blob);
  await upload(service, f, cId, 'claimant_id', 'passport-blurry.pdf', 'C1', blob);
  await upload(service, f, cId, 'relationship_proof', 'marriage-certificate.pdf', 'C1', blob);
  await service.verifyClaim(cId);
  // Open for 16 days against a 14 day documents SLA, so the claim list shows a breach.
  if (opts.repo) await backdateClaim(opts.repo, cId, 16);

  log('\nDemo claims (family portal sign-in):');
  for (const x of [a, b, c]) for (const cl of x.claimants) log(`  ${x.claim.claimId}  passcode ${cl.passcode}  (${cl.name}, claim for ${x.claim.deceasedName})`);
  void ngs;
}
