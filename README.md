# Claim Hub

One place for a grieving family, NGS Super, GROW (Concentrix) and TAL to work on a death benefit claim. The family uploads each document once. Each party updates only the steps it owns.

## Layout

| Folder | Contents |
|---|---|
| `shared` | Step definitions, document checklist and types used everywhere |
| `backend` | API (single Lambda), business rules, DynamoDB/S3 adapters, local server, tests |
| `web` | React app: family portal and the NGS, GROW and TAL staff portals |
| `infra` | CDK stack for ap-southeast-2 |

## Run locally (no AWS)

```
npm install
npm run dev:api     # http://localhost:8787, in-memory data, prints demo claim IDs and passcodes
npm run dev:web     # http://localhost:5173
npm test
```

Family sign-in: use a claim ID and passcode printed by the API. Staff sign-in in local mode: pick a party.
In the demo data, a file name containing "fail" or "blurry" is rejected by the mock GreenID.

## Deploy

```
aws sso login --sso-session hackathon
$env:AWS_PROFILE = "hackathon"
npx cdk bootstrap -w infra      # first time only
npm run deploy                  # builds the web app, then cdk deploy
```

Optional document classification with Bedrock: `npx cdk deploy -c bedrockModelId=<model or inference profile id>`.

Seed demo data and staff users after deploying (values come from the stack outputs):

```
$env:TABLE_NAME=...; $env:BUCKET_NAME=...; $env:USER_POOL_ID=...; $env:DEMO_PASSWORD="<12+ chars>"
npm run seed:aws -w backend
```

Staff users are `ngs.demo@example.com`, `grow.demo@example.com` and `tal.demo@example.com`.

## How the rules work

- Steps: 1 notified and 2 identity confirmed (GROW, done at registration; the family sees one "Claim registered" line), 3 documents (family), 4 verification (GreenID), 5 assess and coordinate (TAL, NGS, GROW), 6 insurer decision (TAL), 7 TAL payment (TAL), 8 trustee decision (NGS), 9 outcome and payment (GROW).
- NGS and GROW see all nine steps. TAL sees steps 1 to 7 only (`STEP_VIEW_LIMIT` in `shared/src/index.ts`): the API hides later steps and their activity from TAL, and refuses TAL's attempts to touch them. A party can only act on the steps it owns.
- A step with several owners completes only when every owner marks done. The next step stays locked until then.
- Staff portals show how long each claim has been open (or how long it took) and the time spent in each step.
- The family portal is available in English, Chinese (Simplified), Vietnamese and Arabic (right-to-left). Translations live in `web/src/i18n.tsx` and need professional review. Staff-written notes are shown as written.
- An owner can reopen its part while the next step is incomplete, or flag a problem with a note the family can see.
- Documents (8 items, 5 required, 3 optional). Shared by the whole claim: death certificate, proof of ID for the deceased (passport, Medicare or driver licence), and optionally probate or letter of administration, a copy of the will, a copy of a court order. One per claimant: proof of ID for the claimant (one of the three), death claim form, bank statement. For ID and probate the customer picks the type first, and only one file is needed. Step 3 completes when every required item is in.
- Document access: NGS and GROW see every document. TAL sees only the death certificate and the deceased's ID (enforced in the API for list, upload, download and the activity log). The rules live in `shared/src/index.ts` as `staffAccess` on each checklist item.
- The family portal shows "The Late <member name>" and the member number (from the register-a-claim form) at the top right, under Sign out.
- NGS and GROW can both register claims and work the claim specialist request queue (call link, mark contacted, close). The request and the activity log record which party called and when. TAL sees neither the claimants section nor the requests.
- NGS and GROW can edit a claimant's name, relationship, contact details and address from the claimant profile. The family can change or cancel a claim specialist request until someone has called, and staff see the change or cancellation in the request list and the activity log.
- Each claimant's share of the payment comes from an allocation feed (`backend/src/allocation.ts`, mocked as a fixed split), never from the register form. Claimant names open a profile with contact details and "Issue new passcode".
- Registering a claim collects an Australian address for each claimant (line 1, optional line 2, suburb, state or territory, 4-digit postcode). NGS and GROW can see it on the claim page. TAL cannot.
- The same file (SHA-256) uploaded twice in a claim is refused, with a message naming where it already is.
- When step 3 completes, a Step Functions workflow sends the documents to GreenID (mocked). Failures send the family back to re-upload only that document.
- The time estimate sums min, average and max duration of the remaining steps from earlier completed claims. Local and seeded data is synthetic.

## Not done yet (prototype limits)

- GreenID is a mock behind `backend/src/greenid.ts`.
- No email or SMS. Passcodes are given to the family by phone. Claim specialist requests appear in the NGS and GROW portals.
- Step updates are read-then-write without optimistic locking. Two parties saving at the same instant could overwrite each other.
- Resources use a DESTROY removal policy. Use RETAIN, add malware scanning for uploads, WAF, and a custom domain for production.
