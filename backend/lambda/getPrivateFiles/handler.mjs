'use strict';
console.log('Loading getPrivateFiles function');

const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET;
const RESERVED_SHARED_PREFIXES = (process.env.RESERVED_SHARED_PREFIXES ?? "Music/,Photos/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map(normalizeFolderPrefix);

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({});

export const handler = async (event) => {
  console.log("request: " + JSON.stringify(event));
  const pathParams = event.pathParameters;
  const method = event.httpMethod;

  try {
    // POST /files  →  presigned PUT URL for uploading (15 min)
    if (method === "POST" && (!pathParams || !pathParams.key)) {
      const body = JSON.parse(event.body ?? "{}");
      const { key, contentType } = body;
      if (!key) return respond(400, { error: "key is required" });
      const url = await getPresignedUploadUrl(key, contentType);
      return respond(200, { url });
    }

    // GET /files  →  list files and folders
    if (method === "GET" && (!pathParams || !pathParams.key)) {
      const prefix = event.queryStringParameters?.prefix ?? "";
      if (prefix === "") await ensureReservedFolders();
      const files = await listFiles(prefix);
      return respond(200, files);
    }

    // DELETE /files/{key+}  →  delete a single file
    if (method === "DELETE" && pathParams?.key) {
      const key = decodeURIComponent(pathParams.key);
      if (isReservedTopFolder(key)) {
        return respond(403, { error: "Cannot delete reserved shared folder" });
      }
      await deleteObject(key);
      return respond(200, { deleted: key });
    }

    // DELETE /files?prefix=xxx&mode=empty|remove  →  delete folder contents
    if (method === "DELETE" && (!pathParams || !pathParams.key)) {
      const prefix = event.queryStringParameters?.prefix ?? "";
      const mode   = event.queryStringParameters?.mode ?? "remove";
      if (!prefix) return respond(400, { error: "prefix is required" });
      if (mode === "remove" && isReservedTopFolder(prefix)) {
        return respond(403, { error: "Cannot remove reserved shared folder" });
      }
      const count = await deletePrefix(prefix, mode === "remove");
      return respond(200, { deleted: count, prefix });
    }

    // GET /files/{key+}  →  presigned download URL (12 hours)
    const key = decodeURIComponent(pathParams.key);
    const url = await getPresignedUrl(key);
    return respond(200, { url });

  } catch (err) {
    console.error(err);
    return respond(500, { error: err.message });
  }
};

function normalizeFolderPrefix(prefix) {
  const trimmed = (prefix ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isReservedTopFolder(prefix) {
  const norm = normalizeFolderPrefix(prefix);
  return RESERVED_SHARED_PREFIXES.includes(norm);
}

async function ensureReservedFolders() {
  await Promise.all(RESERVED_SHARED_PREFIXES.map((key) => ensureFolderMarker(key)));
}

async function ensureFolderMarker(key) {
  const { Contents } = await client.send(
    new ListObjectsV2Command({ Bucket: PRIVATE_BUCKET, Prefix: key, MaxKeys: 1 })
  );
  const exists = (Contents ?? []).some((obj) => obj.Key === key);
  if (exists) return;
  await client.send(new PutObjectCommand({
    Bucket: PRIVATE_BUCKET,
    Key: key,
    Body: "",
    ContentType: "application/x-directory",
  }));
}

async function listFiles(prefix) {
  const command = new ListObjectsV2Command({
    Bucket: PRIVATE_BUCKET, Prefix: prefix, Delimiter: "/",
  });
  let folders = [], files = [], isTruncated = true;
  while (isTruncated) {
    const { IsTruncated, NextContinuationToken, Contents, CommonPrefixes } = await client.send(command);
    isTruncated = IsTruncated ?? false;
    command.input.ContinuationToken = NextContinuationToken;
    if (CommonPrefixes) {
      const folderChecks = await Promise.all(
        CommonPrefixes.map(async (p) => {
          const info = await getFolderInfo(p.Prefix);
          return { key: p.Prefix, type: "folder", hasMp3s: info.hasMp3s,
                   hasSubFolders: info.hasSubFolders, hasFiles: info.hasFiles };
        })
      );
      folders = folders.concat(folderChecks);
    }
    if (Contents) {
      files = files.concat(
        Contents.filter((obj) => obj.Key !== prefix)
          .map((obj) => ({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified, type: "file" }))
      );
    }
  }
  return { folders, files };
}

async function getPresignedUrl(key) {
  const command = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key });
  // 12-hour expiry — covers full music playback sessions without mid-stream expiry
  return getSignedUrl(client, command, { expiresIn: 43200 });
}

async function getPresignedUploadUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: PRIVATE_BUCKET, Key: key,
    ContentType: contentType ?? "application/octet-stream",
  });
  // 15-minute expiry — sufficient for file uploads
  return getSignedUrl(client, command, { expiresIn: 900 });
}

async function getFolderInfo(prefix) {
  const { Contents, CommonPrefixes } = await client.send(
    new ListObjectsV2Command({ Bucket: PRIVATE_BUCKET, Prefix: prefix, Delimiter: "/" })
  );
  const directFiles = (Contents ?? []).filter((obj) => obj.Key !== prefix);
  return {
    hasMp3s:       directFiles.some((obj) => obj.Key.toLowerCase().endsWith(".mp3")),
    hasSubFolders: (CommonPrefixes ?? []).length > 0,
    hasFiles:      directFiles.length > 0,
  };
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
}

async function deletePrefix(prefix, removeFolder) {
  let count = 0, continuationToken;
  do {
    const { Contents, IsTruncated, NextContinuationToken } = await client.send(
      new ListObjectsV2Command({ Bucket: PRIVATE_BUCKET, Prefix: prefix, ContinuationToken: continuationToken })
    );
    continuationToken = IsTruncated ? NextContinuationToken : undefined;
    const keys = (Contents ?? []).map((obj) => obj.Key).filter((k) => removeFolder || k !== prefix);
    if (keys.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: PRIVATE_BUCKET,
        Delete: { Objects: keys.map((k) => ({ Key: k })), Quiet: true },
      }));
      count += keys.length;
    }
  } while (continuationToken);
  return count;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    },
    body: JSON.stringify(body),
  };
}
