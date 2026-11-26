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
  { id: 7, title: 'TAL payment', familyTitle: 'Insurance payment', familyDescription: 'TAL pays the insurance part of your claim.', slaDays: 5, owners: ['tal'] },
  { id: 8, title: 'Trustee decision', familyTitle: 'Trustee decision', familyDescription: 'The trustee decides eligibility and who receives the benefit.', slaDays: 10, owners: ['ngs'] },
  { id: 9, title: 'Payment and Communication', familyTitle: 'Outcome and payment', familyDescription: 'We explain the outcome and arrange payment.', slaDays: 5, owners: ['grow'] },
];

/** The last step a party can see. A party without an entry sees every step. TAL's view ends at its own payment. */
export const STEP_VIEW_LIMIT: Partial<Record<Party, number>> = { tal: 7 };
export const canSeeStep = (party: Party, stepId: number) => stepId <= (STEP_VIEW_LIMIT[party] ?? Infinity);

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
  /** The customer picks exactly one of these before uploading, and only one file is needed. */
  choices?: string[];
  /** Staff parties allowed to see and download this document. Omitted means every party. */
  staffAccess?: Party[];
}

const ID_CHOICES = ['passport', 'medicare', 'drivers_licence'];
const NGS_GROW: Party[] = ['ngs', 'grow'];

/** Fixed list for the prototype. Keyed by claim type so it can vary later. TAL sees only the death certificate and the deceased's ID. */
export const CHECKLISTS: Record<string, ChecklistItem[]> = {
  death_benefit: [
    { slot: 'death_certificate', label: 'Death certificate', description: 'Certified copy of the death certificate.', scope: 'claim' },
    { slot: 'deceased_id', label: 'Proof of ID for the deceased', description: 'Choose one: passport, Medicare card or driver licence.', scope: 'claim', choices: ID_CHOICES },
    { slot: 'claimant_id', label: 'Proof of ID for the claimant', description: 'Choose one: passport, Medicare card or driver licence.', scope: 'claimant', choices: ID_CHOICES, staffAccess: NGS_GROW },
    { slot: 'death_claim_form', label: 'Death claim form', description: 'The completed and signed death claim form.', scope: 'claimant', staffAccess: NGS_GROW },
    { slot: 'bank_statement', label: 'Bank statement', description: 'A recent statement for the account the benefit should be paid into.', scope: 'claimant', staffAccess: NGS_GROW },
    { slot: 'probate', label: 'Probate or letter of administration', description: 'Optional. Choose which one you have.', scope: 'claim', optional: true, choices: ['probate', 'letter_of_administration'], staffAccess: NGS_GROW },
    { slot: 'will', label: 'Copy of the will', description: 'Optional.', scope: 'claim', optional: true, staffAccess: NGS_GROW },
    { slot: 'court_order', label: 'Copy of a court order', description: 'Optional.', scope: 'claim', optional: true, staffAccess: NGS_GROW },
  ],
};
export const DEFAULT_CLAIM_TYPE = 'death_benefit';

export const CHOICE_LABELS: Record<string, string> = {
  passport: 'Passport',
  medicare: 'Medicare card',
  drivers_licence: 'Driver licence',
  probate: 'Probate',
  letter_of_administration: 'Letter of administration',
};

export const canStaffAccess = (party: Party, item: Pick<ChecklistItem, 'staffAccess'>) => !item.staffAccess || item.staffAccess.includes(party);

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
  variant?: string; // the type the customer chose, for slots with choices
  version: number;
  status: 'awaiting_upload' | 'uploaded';
  uploadedBy?: string; // e.g. "family:C-AB12" or "tal:jane"
  uploadedAt?: string;
  verification: DocVerification;
  verificationRef?: string;
  verificationNote?: string;
  classification?: { detectedSlot: string; confidence: number; source: string; mismatch: boolean };
  s3Key?: string; // current version's object key
  pending?: { fileName: string; contentType: string; size: number; key: string; variant?: string };
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
export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;
export type AuState = (typeof AU_STATES)[number];
/** Australian postal address. */
export interface Address {
  line1: string;
  line2?: string;
  suburb: string;
  state: AuState;
  postcode: string; // four digits
}

export interface Claimant {
  claimantId: string;
  claimId: string;
  name: string;
  address?: Address; // required when registering, optional here so older records still load
  allocationPercent?: number; // share of the benefit, supplied by an external party. Never typed in by staff.
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
  status: 'open' | 'contacted' | 'closed' | 'cancelled'; // cancelled = withdrawn by the family
  createdAt: string;
  editedAt?: string; // the family changed the details after sending it
  cancelledAt?: string;
  contactedBy?: string; // e.g. "ngs:ngs.demo", set when someone marks the call as made
  contactedAt?: string;
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
    variant?: string;
    verification: DocVerification;
    verificationNote?: string;
    needsReview: boolean;
  };
}
export interface FamilyTracker {
  claim: { claimId: string; deceasedName: string; memberNumber?: string; registeredAt: string };
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
  closedAt?: string; // set when every step this party can see is complete
  stepLimit?: number; // set when this party only sees steps up to this number
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

