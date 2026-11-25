// Shared model used by the API, the web app and the infrastructure.

export type Party = 'ngs' | 'grow' | 'tal';
export type Owner = Party | 'family' | 'system';
export const PARTIES: Party[] = ['ngs', 'grow', 'tal'];

export const OWNER_LABEL: Record<Owner, string> = {
  ngs: 'NGS Super',
  grow: 'GROW',
  tal: 'TAL',
  family: 'Family',
  system: 'Automated checks',
};

// ---------- Steps ----------

export interface StepDef {
  id: number;
  title: string; // staff-facing
  familyTitle: string;
  familyDescription: string;
  owners: Owner[]; // every owner must mark done for the step to complete
  hiddenFromFamily?: boolean;
  slaDays: number; // target calendar days to complete the step, from when it becomes available
}

export const STEPS: StepDef[] = [
  { id: 1, title: 'Claim notified', familyTitle: 'Claim registered', familyDescription: 'Your claim has been registered.', slaDays: 5, owners: ['grow'], hiddenFromFamily: true },
  { id: 2, title: 'Identity and cover confirmed', familyTitle: 'Identity confirmed', familyDescription: 'Identity and cover were confirmed on your call.', slaDays: 5, owners: ['grow'], hiddenFromFamily: true },
  { id: 3, title: 'Documents collected', familyTitle: 'Upload your documents', familyDescription: 'Upload the documents on your checklist. Each document only needs to be uploaded once, and NGS Super, TAL and GROW can all see it.', slaDays: 14, owners: ['family'] },
  { id: 4, title: 'Documents verified', familyTitle: 'We verify your documents', familyDescription: 'Your documents are checked with our identity verification partner, GreenID.', slaDays: 1, owners: ['system'] },
  { id: 5, title: 'Assess and coordinate', familyTitle: 'We assess your claim', familyDescription: 'NGS Super, TAL and GROW review your claim together. You do not need to contact each of them.', slaDays: 10, owners: ['tal', 'ngs', 'grow'] },
  { id: 6, title: 'Insurer decision', familyTitle: 'Insurer decision', familyDescription: 'TAL, the insurer, decides whether the insurance part of your claim is accepted.', slaDays: 5, owners: ['tal'] },
  { id: 7, title: 'Trustee decision', familyTitle: 'Trustee decision', familyDescription: 'The trustee decides eligibility and who receives the benefit.', slaDays: 10, owners: ['ngs'] },
  { id: 8, title: 'Communicate outcome and pay', familyTitle: 'Outcome and payment', familyDescription: 'We explain the outcome and arrange payment.', slaDays: 5, owners: ['grow', 'tal'] },
];

export type OwnerStatus = 'pending' | 'done' | 'blocked';
export interface OwnerState {
  status: OwnerStatus;
  note?: string;
  updatedBy?: string;
  updatedAt?: string;
}
export interface StepState {
  claimId: string;
  stepId: number;
  owners: Partial<Record<Owner, OwnerState>>;
  completedAt?: string;
}

export type StepStatus = 'locked' | 'in_progress' | 'blocked' | 'completed';
export interface DerivedStep {
  def: StepDef;
  state: StepState;
  status: StepStatus;
  pendingOwners: Owner[]; // owners who have not marked done
  blockedOwners: Owner[];
}

export function emptyStepState(claimId: string, def: StepDef): StepState {
  const owners: StepState['owners'] = {};
  for (const o of def.owners) owners[o] = { status: 'pending' };
  return { claimId, stepId: def.id, owners };
}

/** A step is complete when all owners are done. A step is locked until every earlier step is complete. */
export function deriveSteps(states: StepState[], claimId = ''): DerivedStep[] {
  let allPreviousComplete = true;
  return STEPS.map((def) => {
    const state = states.find((s) => s.stepId === def.id) ?? emptyStepState(claimId, def);
    const pendingOwners = def.owners.filter((o) => state.owners[o]?.status !== 'done');
    const blockedOwners = def.owners.filter((o) => state.owners[o]?.status === 'blocked');
    const complete = pendingOwners.length === 0;
    const status: StepStatus = complete ? 'completed' : !allPreviousComplete ? 'locked' : blockedOwners.length ? 'blocked' : 'in_progress';
    allPreviousComplete = allPreviousComplete && complete;
    return { def, state, status, pendingOwners, blockedOwners };
  });
}

// ---------- Documents ----------

export type DocScope = 'claim' | 'claimant';
export interface ChecklistItem {
  slot: string;
  label: string;
  description: string;
  scope: DocScope; // claim = shared by all claimants, claimant = one per claimant
  optional?: boolean;
}

/** Fixed list for the prototype. Keyed by claim type so it can vary later. */
export const CHECKLISTS: Record<string, ChecklistItem[]> = {
  death_benefit: [
    { slot: 'death_certificate', label: 'Death certificate', description: 'Certified copy of the death certificate.', scope: 'claim' },
    { slot: 'will', label: 'Will or grant of probate', description: 'If there is one. Skip if not applicable.', scope: 'claim', optional: true },
    { slot: 'claimant_id', label: 'Photo ID', description: 'Driver licence or passport.', scope: 'claimant' },
    { slot: 'relationship_proof', label: 'Proof of relationship', description: 'For example a marriage or birth certificate.', scope: 'claimant' },
  ],
};
export const DEFAULT_CLAIM_TYPE = 'death_benefit';

export type DocVerification = 'not_started' | 'pending' | 'verified' | 'failed';
export interface DocRecord {
  docId: string;
  claimId: string;
  slot: string;
  claimantId: string | null; // null for shared documents
  fileName: string;
  contentType: string;
  size: number;
  sha256?: string;
  version: number;
  status: 'awaiting_upload' | 'uploaded';
  uploadedBy?: string; // e.g. "family:C-AB12" or "tal:jane"
  uploadedAt?: string;
  verification: DocVerification;
  verificationRef?: string;
  verificationNote?: string;
  classification?: { detectedSlot: string; confidence: number; source: string; mismatch: boolean };
  s3Key?: string; // current version's object key
  pending?: { fileName: string; contentType: string; size: number; key: string };
}

// ---------- Claims ----------

export interface Claim {
  claimId: string;
  deceasedName: string;
  memberNumber?: string;
  claimType: string;
  createdAt: string;
  createdBy: string;
}
export interface Claimant {
  claimantId: string;
  claimId: string;
  name: string;
  relationship: string;
  email?: string;
  phone?: string;
  passcodeExpiresAt: string;
}
export interface SupportRequest {
  requestId: string;
  claimId: string;
  claimantId: string;
  claimantName: string;
  phone: string;
  preferredTime: string;
  topic: string;
  status: 'open' | 'contacted' | 'closed';
  createdAt: string;
  updatedBy?: string;
}
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

// ---------- API shapes ----------

export interface Estimate {
  basedOnCases: number;
  remainingDays: { min: number; avg: number; max: number };
}

export interface FamilyStepView {
  stepId: number;
  title: string;
  description: string;
  status: 'done' | 'current' | 'attention' | 'upcoming';
  waitingOn: Owner[]; // owners still to act
  note?: string;
}
export interface ChecklistView extends ChecklistItem {
  claimantId: string | null;
  doc?: {
    docId: string;
    fileName: string;
    uploadedAt?: string;
    uploadedByYou: boolean;
    verification: DocVerification;
    verificationNote?: string;
    needsReview: boolean;
  };
}
export interface FamilyTracker {
  claim: { claimId: string; deceasedName: string; registeredAt: string };
  claimant: { claimantId: string; name: string };
  steps: FamilyStepView[];
  checklist: ChecklistView[];
  estimate: Estimate | null;
  counsellingUrl: string;
  supportRequests: SupportRequest[];
}

export interface ClaimSummary {
  claim: Claim;
  claimantCount: number;
  // null when all steps are complete. startedAt is when the step became available (the previous step completed).
  currentStep: { id: number; title: string; status: StepStatus; startedAt: string; slaDays: number } | null;
  waitingOn: Owner[];
  closedAt?: string; // set when every step is complete
  docsReceived: number;
  docsRequired: number;
}
export interface StaffClaimDetail {
  claim: Claim;
  claimants: Claimant[];
  closedAt?: string;
  steps: { stepId: number; title: string; status: StepStatus; owners: { owner: Owner; state: OwnerState }[]; completedAt?: string }[];
  checklist: (ChecklistItem & { claimantId: string | null; doc?: DocRecord })[];
  audit: AuditEntry[];
  supportRequests: SupportRequest[];
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

