'use strict';
console.log('Loading getDlivPhotoBuckets function');

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({});
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;

/** Parent prefix for albums (e.g. `images/`). Empty = bucket root. Always ends with `/` when non-empty. */
function normalizeParentPrefix(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;

async function deriveAlbumsFromFlatKeys(bucket, parentPrefix) {
  const seen = new Map();
  let token;
  do {
    const r = await client.send(
      new ListObjectsV2Command({
        Bucket:            bucket,
        Prefix:            parentPrefix || undefined,
        ContinuationToken: token,
      })
    );

    for (const obj of r.Contents ?? []) {
      const key = obj.Key;
      if (!key || key.endsWith("/") || !IMAGE_EXT.test(key)) continue;

      const relative = parentPrefix ? key.slice(parentPrefix.length) : key;
      const slash      = relative.indexOf("/");

      if (slash === -1) {
        seen.set("root", { name: "root", prefix: parentPrefix });
      } else {
        const segment = relative.slice(0, slash);
        const pathPrefix = `${parentPrefix}${segment}/`;
        if (!seen.has(segment)) seen.set(segment, { name: segment, prefix: pathPrefix });
      }
    }

    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  return [...seen.values()].sort((a, b) =>
    a.name === "root" ? -1 : b.name === "root" ? 1 : a.name.localeCompare(b.name)
  );
}

export const handler = async () => {
  try {
    const PARENT = normalizeParentPrefix(process.env.PUBLIC_SLIDESHOW_PREFIX);

    let albums = [];

    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket:    PUBLIC_BUCKET,
        Prefix:    PARENT || undefined,
        Delimiter: "/",
      })
    );

    albums = (resp.CommonPrefixes ?? []).map((p) => {
      const full = p.Prefix;
      const name = PARENT ? full.slice(PARENT.length).replace(/\/$/, "") : full.replace(/\/$/, "");
      return { name, prefix: full };
    });

    // One top-level folder under bucket root — drill in (e.g. everything under `images/`)
    if (albums.length === 1 && PARENT === "") {
      const sole = albums[0];
      const sub = await client.send(
        new ListObjectsV2Command({
          Bucket:    PUBLIC_BUCKET,
          Prefix:    sole.prefix,
          Delimiter: "/",
        })
      );
      const subs = sub.CommonPrefixes ?? [];
      if (subs.length > 0) {
        albums = subs.map((p) => ({
          name: p.Prefix.slice(sole.prefix.length).replace(/\/$/, ""),
          prefix: p.Prefix,
        }));
      }
    }

    if (albums.length === 0) {
      albums = await deriveAlbumsFromFlatKeys(PUBLIC_BUCKET, PARENT);
    }

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
      "Content-Type":                 "application/json; charset=utf-8",
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
