'use strict';
console.log('Loading demos function');

import { randomBytes } from "node:crypto";
import { S3Client, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DEMO_PREFIX, demoObjectKey, demoViewFromKey, planDemoUpload } from "./demoFile.mjs";

// A public bucket whose name contains a dot (dliv.com-2) has no virtual-host
// TLS certificate. Path-style URLs match the host the browser can actually open.
const client = new S3Client({ forcePathStyle: true });
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const REGION = process.env.AWS_REGION ?? "us-east-1";

export const handler = async (event) => {
  try {
    if (event.httpMethod === "GET") return await listDemos();
    if (event.httpMethod === "POST") return await createUpload(event);
    return respond(405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Demo request failed" });
  }
};

async function listDemos() {
  const demos = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: PUBLIC_BUCKET,
      Prefix: DEMO_PREFIX,
      ContinuationToken: token,
    }));
    for (const obj of page.Contents ?? []) {
      const view = demoViewFromKey(PUBLIC_BUCKET, REGION, obj.Key, obj.Size, obj.LastModified);
      if (view) demos.push(view);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  demos.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return respond(200, { demos });
}

async function createUpload(event) {
  const sub = event.requestContext?.authorizer?.claims?.sub;
  if (!sub) return respond(401, { error: "Sign in to add a demo." });
  const body = parseBody(event.body);
  const plan = planDemoUpload(body);
  if (!plan.ok) return respond(400, { error: plan.error });
  const key = demoObjectKey(plan.filename, new Date(), randomBytes(4).toString("hex"));
  const url = await getSignedUrl(client, new PutObjectCommand({
    Bucket: PUBLIC_BUCKET,
    Key: key,
    ContentType: plan.contentType,
  }), { expiresIn: 900 });
  return respond(200, {
    url,
    key,
    contentType: plan.contentType,
    publicUrl: demoViewFromKey(PUBLIC_BUCKET, REGION, key, plan.size, new Date()).url,
  });
}

function parseBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    },
    body: JSON.stringify(body),
  };
}
