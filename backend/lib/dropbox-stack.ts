// backend/lib/dropbox-stack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export interface DropboxConfig {
  id:            string;
  awsRegion:     string;
  userPoolId:    string;
  privateBucket: string;
  publicBucket:  string;
}

export interface DropboxStackProps extends cdk.StackProps {
  config:               DropboxConfig;
  dropboxClientId?:     string;  // existing Cognito app client — preserved by deploy.sh
  dropboxApiLogicalId?: string;  // existing API GW logical ID — prevents recreation
}

export class DropboxStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DropboxStackProps) {
    super(scope, id, props);

    const { config, dropboxClientId, dropboxApiLogicalId } = props;

    // ── Cognito — import existing User Pool ───────────────────────────────────
    const userPool = cognito.UserPool.fromUserPoolId(
      this, "UserPool", config.userPoolId
    );

    // ── Cognito App Client ────────────────────────────────────────────────────
    // Managed by deploy.sh — created once, never recreated.
    let appClientId: string;
    if (dropboxClientId) {
      appClientId = dropboxClientId;
    } else {
      // First deploy only — deploy.sh persists the ID for all future runs.
      const appClient = userPool.addClient("DropboxAppClient", {
        userPoolClientName: `${config.id}-dropbox-client`,
        authFlows: {
          userPassword:      true,
          userSrp:           true,
          adminUserPassword: true,
        },
        preventUserExistenceErrors: true,
      });
      appClientId = appClient.userPoolClientId;
    }

    // ── Lambda ────────────────────────────────────────────────────────────────
    const getPrivateFilesLambda = new lambda.Function(this, "GetPrivateFiles", {
      runtime:     lambda.Runtime.NODEJS_20_X,
      handler:     "handler.handler",
      code:        lambda.Code.fromAsset(path.join(__dirname, "../lambda/getPrivateFiles")),
      environment: { PRIVATE_BUCKET: config.privateBucket },
      timeout:     cdk.Duration.seconds(10),
    });

    // ── Slideshow Lambdas ──────────────────────────────────────────────────────
    const getDlivPhotoBucketsLambda = new lambda.Function(this, "GetDlivPhotoBuckets", {
      runtime:     lambda.Runtime.NODEJS_20_X,
      handler:     "handler.handler",
      code:        lambda.Code.fromAsset(path.join(__dirname, "../lambda/getDlivPhotoBuckets")),
      environment: { PUBLIC_BUCKET: config.publicBucket },
      timeout:     cdk.Duration.seconds(10),
    });

    const getDlivPhotosLambda = new lambda.Function(this, "GetDlivPhotos", {
      runtime:     lambda.Runtime.NODEJS_20_X,
      handler:     "handler.handler",
      code:        lambda.Code.fromAsset(path.join(__dirname, "../lambda/getDlivPhotos")),
      environment: { PUBLIC_BUCKET: config.publicBucket },
      timeout:     cdk.Duration.seconds(10),
    });

    // ── IAM — public bucket read for slideshow Lambdas ────────────────────────
    const publicBucketReadPolicy = new iam.PolicyStatement({
      actions:   ["s3:GetObject", "s3:ListBucket"],
      resources: [
        `arn:aws:s3:::${config.publicBucket}`,
        `arn:aws:s3:::${config.publicBucket}/*`,
      ],
    });
    getDlivPhotoBucketsLambda.addToRolePolicy(publicBucketReadPolicy);
    getDlivPhotosLambda.addToRolePolicy(publicBucketReadPolicy);

    // ── IAM — explicit policy covering private bucket ─────────────────────────
    getPrivateFilesLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:ListBucket",
      ],
      resources: [
        `arn:aws:s3:::${config.privateBucket}`,
        `arn:aws:s3:::${config.privateBucket}/*`,
      ],
    }));

    // ── API Gateway ───────────────────────────────────────────────────────────
    // Created once. deploy.sh passes real CloudFormation logical ID on subsequent
    // deploys so CDK updates in place — never recreates the API Gateway.
    const api = new apigateway.RestApi(this, "DropboxApi", {
      restApiName: `${config.id}-dropbox-api`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    // So browsers can read error bodies / diagnose failures (e.g. missing route → 403).
    api.addGatewayResponse("Default4XX", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin":  "'*'",
        "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
      },
    });
    api.addGatewayResponse("Default5XX", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin":  "'*'",
        "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
      },
    });

    if (dropboxApiLogicalId) {
      const cfnApi = api.node.defaultChild as cdk.CfnResource;
      cfnApi.overrideLogicalId(dropboxApiLogicalId);
    }

    // ── Cognito Authorizer ────────────────────────────────────────────────────
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this, "DropboxAuthorizer",
      { cognitoUserPools: [userPool] }
    );
    const authOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // ── Routes ────────────────────────────────────────────────────────────────
    const files = api.root.addResource("files");
    files.addMethod("GET",    new apigateway.LambdaIntegration(getPrivateFilesLambda), authOptions);
    files.addMethod("POST",   new apigateway.LambdaIntegration(getPrivateFilesLambda), authOptions);
    files.addMethod("DELETE", new apigateway.LambdaIntegration(getPrivateFilesLambda), authOptions);
    const fileKey = files.addResource("{key+}");
    fileKey.addMethod("GET",    new apigateway.LambdaIntegration(getPrivateFilesLambda), authOptions);
    fileKey.addMethod("DELETE", new apigateway.LambdaIntegration(getPrivateFilesLambda), authOptions);

    // ── Slideshow routes (no auth — public) ───────────────────────────────────
    const albums = api.root.addResource("albums");
    albums.addMethod("GET", new apigateway.LambdaIntegration(getDlivPhotoBucketsLambda));
    const album = albums.addResource("{album}");
    album.addMethod("GET", new apigateway.LambdaIntegration(getDlivPhotosLambda));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "DropboxApiUrl",        { value: api.url });
    new cdk.CfnOutput(this, "DropboxApiId",         { value: api.restApiId });
    new cdk.CfnOutput(this, "DropboxUserPoolId",    { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "DropboxAppClientId",   { value: appClientId });
    new cdk.CfnOutput(this, "DropboxPrivateBucket", { value: config.privateBucket });
    new cdk.CfnOutput(this, "DropboxPublicBucket",  { value: config.publicBucket });
  }
}
