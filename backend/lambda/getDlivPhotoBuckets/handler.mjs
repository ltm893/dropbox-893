'use strict';
console.log('Loading getDlivPhotoBuckets function');

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({});
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;

export const handler = async () => {
  try {
    const { CommonPrefixes } = await client.send(
      new ListObjectsV2Command({
        Bucket:    PUBLIC_BUCKET,
        Delimiter: "/",
      })
    );

    const albums = (CommonPrefixes ?? []).map((p) => {
      const name = p.Prefix.replace(/\/$/, "");
      return { name, prefix: p.Prefix };
    });

    return respond(200, { albums });
  } catch (err) {
    console.error(err);
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
