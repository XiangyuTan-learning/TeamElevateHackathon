import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

export class ClaimHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // Prototype: everything is destroyed with the stack. Switch to RETAIN for production.
    const removal = cdk.RemovalPolicy.DESTROY;

    // ---------- Data ----------
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: removal,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    // ---------- Web hosting ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: removal,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'Site', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html' })),
    });
    const siteOrigin = `https://${distribution.distributionDomainName}`;
    const origins_ = [siteOrigin, 'http://localhost:5173'];

    // ---------- Central document store ----------
    const docs = new s3.Bucket(this, 'DocumentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      removalPolicy: removal,
      autoDeleteObjects: true,
      cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT], allowedOrigins: origins_, allowedHeaders: ['*'], exposedHeaders: ['ETag'] }],
    });

    // ---------- Staff identity ----------
    const pool = new cognito.UserPool(this, 'StaffPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: removal,
    });
    for (const g of ['ngs', 'grow', 'tal']) new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: pool.userPoolId, groupName: g });
    const client = pool.addClient('Web', {
      authFlows: { userPassword: true },
      generateSecret: false,
      idTokenValidity: cdk.Duration.hours(1),
      preventUserExistenceErrors: true,
    });

    const familySecret = new secretsmanager.Secret(this, 'FamilyTokenSecret', {
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: removal,
    });

    // ---------- Verification workflow ----------
    const baseEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: docs.bucketName,
      USER_POOL_ID: pool.userPoolId,
      CLIENT_ID: client.userPoolClientId,
      SECRET_ARN: familySecret.secretArn,
      COUNSELLING_URL: 'https://example.com/member-counselling', // mock link
      BEDROCK_MODEL_ID: (this.node.tryGetContext('bedrockModelId') as string | undefined) ?? '',
    };
    const fnProps = (handler: string, env: Record<string, string>) => ({
      entry: path.join(root, 'backend/src/lambda.ts'),
      handler,
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      environment: env,
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    const verifyFn = new NodejsFunction(this, 'VerifyFn', fnProps('verifyHandler', { ...baseEnv, STATE_MACHINE_ARN: 'not-used-here' }));
    const stateMachine = new sfn.StateMachine(this, 'VerifyDocuments', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        new sfn.Wait(this, 'Queue for GreenID', { time: sfn.WaitTime.duration(cdk.Duration.seconds(5)) }).next(
          new tasks.LambdaInvoke(this, 'Verify documents with GreenID', { lambdaFunction: verifyFn, payloadResponseOnly: true }),
        ),
      ),
      timeout: cdk.Duration.minutes(5),
    });

    // ---------- API ----------
    const apiFn = new NodejsFunction(this, 'ApiFn', fnProps('handler', { ...baseEnv, STATE_MACHINE_ARN: stateMachine.stateMachineArn }));
    for (const fn of [apiFn, verifyFn]) {
      table.grantReadWriteData(fn);
      docs.grantReadWrite(fn);
    }
    familySecret.grantRead(apiFn);
    stateMachine.grantStartExecution(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] }));

    const api = new apigwv2.HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: origins_,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration: new HttpLambdaIntegration('ApiIntegration', apiFn) });
    (api.defaultStage!.node.defaultChild as apigwv2.CfnStage).defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    // ---------- Publish the web app with its runtime config ----------
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        s3deploy.Source.asset(path.join(root, 'web/dist')),
        s3deploy.Source.jsonData('config.json', { mode: 'aws', apiUrl: api.apiEndpoint, region: this.region, clientId: client.userPoolClientId }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'BucketName', { value: docs.bucketName });
  }
}
