import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createApi } from './api';
import { CognitoAuthenticator } from './auth';
import { S3Blob } from './blob';
import { BedrockClassifier, FilenameClassifier } from './classifier';
import { MockGreenId } from './greenid';
import { DynamoKV } from './kv';
import { Repo } from './repo';
import { Service } from './service';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing environment variable ${k}`);
  return v;
};

let secret: string | undefined;
const getSecret = async () => {
  if (!secret) {
    const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env('SECRET_ARN') }));
    secret = r.SecretString!;
  }
  return secret;
};

const sfn = new SFNClient({});
export const service = new Service({
  repo: new Repo(new DynamoKV(env('TABLE_NAME'))),
  blob: new S3Blob(env('BUCKET_NAME')),
  classifier: process.env.BEDROCK_MODEL_ID ? new BedrockClassifier(process.env.BEDROCK_MODEL_ID) : new FilenameClassifier(),
  greenId: new MockGreenId(),
  counsellingUrl: process.env.COUNSELLING_URL ?? 'https://www.tal.com.au/claims/health-support/grief-support',
  startVerification: async (claimId) => {
    await sfn.send(new StartExecutionCommand({ stateMachineArn: env('STATE_MACHINE_ARN'), input: JSON.stringify({ claimId }) }));
  },
});

const handle = createApi(service, new CognitoAuthenticator(env('USER_POOL_ID'), env('CLIENT_ID'), getSecret), getSecret);

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  const r = await handle({ method: event.requestContext.http.method, path: event.rawPath, headers, body });
  return { statusCode: r.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) };
};

/** Step Functions task: send the claim's documents to GreenID and update the steps. */
export const verifyHandler = async (event: { claimId: string }) => {
  await service.verifyClaim(event.claimId);
  return { claimId: event.claimId };
};
