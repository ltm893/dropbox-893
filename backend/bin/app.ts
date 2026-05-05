#!/usr/bin/env node
// backend/bin/app.ts
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DropboxStack } from "../lib/dropbox-stack";
import { config } from "./config";

const app = new cdk.App();

const stackName = `DropboxStack-${config.id}`;

// Pre-resolved by deploy.sh idempotency checks.
// When set, CDK updates in place — never recreates.
const dropboxClientId     = process.env.DROPBOX_CLIENT_ID      || undefined;
const dropboxApiLogicalId = process.env.DROPBOX_API_LOGICAL_ID || undefined;

new DropboxStack(app, stackName, {
  config,
  dropboxClientId,
  dropboxApiLogicalId,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  config.awsRegion,
  },
});
