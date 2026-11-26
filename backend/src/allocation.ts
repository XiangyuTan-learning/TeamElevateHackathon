export interface AllocationInput {
  claimantId: string;
  relationship: string;
}
/**
 * Supplies each claimant's share of the benefit, as whole percentages that add up to 100.
 * In production this is fed by the external party who determines entitlement. Staff never type it in.
 */
export interface BenefitAllocator {
  allocate(claimants: AllocationInput[]): Promise<Record<string, number>>;
}

/** Mock feed: a fixed split by number of claimants, in the order they were registered. */
export class MockBenefitAllocator implements BenefitAllocator {
  private static SPLITS: Record<number, number[]> = { 1: [100], 2: [60, 40], 3: [50, 30, 20], 4: [40, 30, 20, 10] };
  async allocate(claimants: AllocationInput[]) {
    const n = claimants.length;
    const split = MockBenefitAllocator.SPLITS[n] ?? claimants.map((_, i) => Math.floor(100 / n) + (i < 100 % n ? 1 : 0));
    return Object.fromEntries(claimants.map((c, i) => [c.claimantId, split[i]!]));
  }
}
