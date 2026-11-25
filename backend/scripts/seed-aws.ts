// Seeds a deployed stack: duration statistics, demo claims and demo staff users.
// Usage: AWS_PROFILE=hackathon TABLE_NAME=... BUCKET_NAME=... USER_POOL_ID=... DEMO_PASSWORD=... npx tsx scripts/seed-aws.ts
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Blob } from '../src/blob';
import { FilenameClassifier } from '../src/classifier';
import { MockGreenId } from '../src/greenid';
import { DynamoKV } from '../src/kv';
import { Repo } from '../src/repo';
import { seedDemoClaims, seedStats } from '../src/seed-data';
import { Service } from '../src/service';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k}`);
  return v;
};
const password = env('DEMO_PASSWORD');
if (password.length < 12) throw new Error('DEMO_PASSWORD must be at least 12 characters');

const cognito = new CognitoIdentityProviderClient({});
const pool = env('USER_POOL_ID');
for (const party of ['ngs', 'grow', 'tal']) {
  const Username = `${party}.demo@example.com`;
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: pool, Username, MessageAction: 'SUPPRESS', UserAttributes: [{ Name: 'email', Value: Username }, { Name: 'email_verified', Value: 'true' }] }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'UsernameExistsException') throw e;
  }
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username, GroupName: party }));
  console.log(`staff user ${Username} (${party})`);
}

const repo = new Repo(new DynamoKV(env('TABLE_NAME')));
const blob = new S3Blob(env('BUCKET_NAME'));
const service = new Service({ repo, blob, classifier: new FilenameClassifier(), greenId: new MockGreenId(), counsellingUrl: '', startVerification: async () => {} });
await seedStats(repo);
await seedDemoClaims(service, blob, { repo });
