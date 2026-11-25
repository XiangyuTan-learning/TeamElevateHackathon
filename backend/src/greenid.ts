import { randomBytes } from 'node:crypto';

export interface VerifyInput {
  fileName: string;
  sha256: string;
  slot: string;
}
export interface VerifyResult {
  result: 'verified' | 'failed';
  reference: string;
  note?: string;
}
/** Adapter for the GreenID document certification service. Replace the mock with the real API call. */
export interface GreenId {
  verify(input: VerifyInput): Promise<VerifyResult>;
}

/** Mock. Any file name containing "fail" or "blurry" is rejected, so the demo can show a failed document. */
export class MockGreenId implements GreenId {
  async verify({ fileName }: VerifyInput): Promise<VerifyResult> {
    const reference = `GID-${randomBytes(4).toString('hex').toUpperCase()}`;
    if (/fail|blurry/i.test(fileName)) return { result: 'failed', reference, note: 'The document could not be read clearly. Please upload a clearer copy.' };
    return { result: 'verified', reference };
  }
}
