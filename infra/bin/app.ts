import * as cdk from 'aws-cdk-lib';
import { ClaimHubStack } from '../lib/stack';

const app = new cdk.App();
new ClaimHubStack(app, 'ClaimHub', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-southeast-2' } });
