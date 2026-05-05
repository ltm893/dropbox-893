'use strict';
console.log('Loading getDlivPhotos function');

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({});
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const REGION        = process.env.AWS_REGION ?? "us-east-1";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

/**
 * Browser-safe URL for anonymous GET.
 * Virtual-hosted URLs (`https://bucket.s3.region.amazonaws.com/key`) break HTTPS on many
 * browsers when `bucket` contains "." (e.g. dliv.com-2) — cert / host mismatch.
 * Path-style avoids that: `https://s3.region.amazonaws.com/bucket/key`.
 */
function objectPublicGETUrl(bucket, region, key) {
  const pathEncodedKey = key
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  if (bucket.includes(".")) {
    return `https://s3.${region}.amazonaws.com/${bucket}/${pathEncodedKey}`;
  }

  const legacyVirtualHostKey = encodeURIComponent(key).replace(/%2F/g, "/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${legacyVirtualHostKey}`;
}

/** Same rules as getDlivPhotoBuckets — parent prefix for slideshow keys. */
function normalizeParentPrefix(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

export const handler = async (event) => {
  try {
    const albumRaw = event.pathParameters?.album;
    if (!albumRaw) return respond(400, { error: "album is required" });

    const album = decodeURIComponent(albumRaw);
    const PARENT = normalizeParentPrefix(process.env.PUBLIC_SLIDESHOW_PREFIX);

    let prefix;
    if (album === "root") {
      prefix = PARENT;
    } else {
      const slug = album.endsWith("/") ? album.slice(0, -1) : album;
      prefix = `${PARENT}${slug}/`;
    }

    const photos = [];
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
        if (!filename || filename.includes("/")) continue;
        photos.push({
          key:          obj.Key,
          filename,
          url:          objectPublicGETUrl(PUBLIC_BUCKET, REGION, obj.Key),
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
      "Content-Type":                 "application/json; charset=utf-8",
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
