'use strict';
console.log('Loading getDlivPhotos function');

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({});
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const REGION        = process.env.AWS_REGION ?? "us-east-1";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

export const handler = async (event) => {
  try {
    const album = event.pathParameters?.album;
    if (!album) return respond(400, { error: "album is required" });

    const prefix = album.endsWith("/") ? album : `${album}/`;
    const photos  = [];
    let   token;

    do {
      const { Contents, IsTruncated, NextContinuationToken } = await client.send(
        new ListObjectsV2Command({
          Bucket:            PUBLIC_BUCKET,
          Prefix:            prefix,
          ContinuationToken: token,
        })
      );

      for (const obj of Contents ?? []) {
        const ext = obj.Key.slice(obj.Key.lastIndexOf(".")).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const filename = obj.Key.slice(prefix.length);
        if (!filename) continue;                          // skip the folder key itself
        photos.push({
          key:          obj.Key,
          filename,
          url:          `https://${PUBLIC_BUCKET}.s3.${REGION}.amazonaws.com/${encodeURIComponent(obj.Key).replace(/%2F/g, "/")}`,
          size:         obj.Size,
          lastModified: obj.LastModified,
        });
      }

      token = IsTruncated ? NextContinuationToken : undefined;
    } while (token);

    return respond(200, { album, photos });
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
