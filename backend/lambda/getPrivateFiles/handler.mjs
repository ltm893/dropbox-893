'use strict';
console.log('Loading getPrivateFiles function');

const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET;
const RESERVED_SHARED_PREFIXES = (process.env.RESERVED_SHARED_PREFIXES ?? "Music/,Photos/,Videos/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map(normalizeFolderPrefix);

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { destKeyForMove, destKeyForRename } from "./destKey.mjs";
import {
  assertRenameInPersonalLibrary,
  assertUploadInOwnLibrary,
  isSharedLibraryKey,
  mayRemoveSharedObject,
  metadataWithOwner,
  shareDestForKey,
  shareFolderContentsError,
  shareOwnerFolderName,
  sharedOwnerFromMetadata,
} from "./shareKey.mjs";

const SHARE_COPY_CONCURRENCY = 8;
const MAX_SHARED_BYTES = 5 * 1024 * 1024 * 1024;

const client = new S3Client({});

export const handler = async (event) => {
  console.log("request: " + JSON.stringify(event));
  const pathParams = event.pathParameters;
  const method = event.httpMethod;

  try {
    // POST /files/share  →  copy a library file or folder to All DLIV Users
    if (method === "POST" && isSharePath(event)) {
      return await shareWithAll(event);
    }

    // POST /files  →  presigned PUT URL for uploading (15 min)
    if (method === "POST" && (!pathParams || !pathParams.key)) {
      const body = JSON.parse(event.body ?? "{}");
      const { key, contentType } = body;
      if (!key) return respond(400, { error: "key is required" });
      assertUploadInOwnLibrary(key, userSub(event));
      const url = await getPresignedUploadUrl(key, contentType);
      return respond(200, { url });
    }

    // GET /files  →  list files and folders
    if (method === "GET" && (!pathParams || !pathParams.key)) {
      const prefix = event.queryStringParameters?.prefix ?? "";
      const userId = userSub(event);
      if (prefix === "") await ensureReservedFolders();
      if (isMineRootPrefix(prefix, userId)) await ensureUserLibraryFolders(userId);
      const files = await listFiles(prefix);
      return respond(200, files);
    }

    // DELETE /files/{key+}  →  delete a single file
    if (method === "DELETE" && pathParams?.key) {
      const key = decodeURIComponent(pathParams.key);
      if (isReservedTopFolder(key, userSub(event))) {
        return respond(403, { error: "Cannot delete reserved shared folder" });
      }
      await assertCanRemoveSharedKey(key, userSub(event));
      await deleteObject(key);
      return respond(200, { deleted: key });
    }

    // DELETE /files?prefix=xxx&mode=empty|remove  →  delete folder contents
    if (method === "DELETE" && (!pathParams || !pathParams.key)) {
      const prefix = event.queryStringParameters?.prefix ?? "";
      const mode   = event.queryStringParameters?.mode ?? "remove";
      if (!prefix) return respond(400, { error: "prefix is required" });
      if (mode === "remove" && isReservedTopFolder(prefix, userSub(event))) {
        return respond(403, { error: "Cannot remove reserved shared folder" });
      }
      await assertCanRemoveSharedPrefix(prefix, userSub(event));
      const count = await deletePrefix(prefix, mode === "remove");
      return respond(200, { deleted: count, prefix });
    }

    // PATCH /files  →  rename in place, or move inside the caller's library
    if (method === "PATCH" && (!pathParams || !pathParams.key)) {
      const body = JSON.parse(event.body ?? "{}");
      const fromKey = String(body.key || "").replace(/^\/+/, "");
      if (Object.prototype.hasOwnProperty.call(body, "destPrefix")) {
        const dest = destKeyForMove(fromKey, body.destPrefix, userSub(event));
        if (dest.unchanged) return respond(200, { key: dest.destKey, name: dest.name, unchanged: true });
        const moved = dest.folder
          ? await renamePrefix(dest.fromKey, dest.destKey)
          : await renameObject(fromKey, dest.destKey);
        return respond(200, { key: moved, name: dest.name, from: dest.fromKey });
      }
      const dest = destKeyForRename(fromKey, body.name);
      if (dest.unchanged) return respond(200, { key: dest.destKey, name: dest.name, unchanged: true });
      if (isReservedTopFolder(fromKey, userSub(event)) || isReservedTopFolder(dest.destKey, userSub(event))) {
        return respond(403, { error: "Cannot rename a reserved folder" });
      }
      assertRenameInPersonalLibrary(fromKey);
      assertRenameInPersonalLibrary(dest.destKey);
      const renamed = dest.folder
        ? await renamePrefix(dest.fromKey, dest.destKey)
        : await renameObject(fromKey, dest.destKey);
      return respond(200, { key: renamed, name: dest.name, from: dest.fromKey || fromKey });
    }

    if (!pathParams?.key) return respond(404, { error: "Not found" });
    const key = decodeURIComponent(pathParams.key);
    const url = await getPresignedUrl(key);
    return respond(200, { url });

  } catch (err) {
    console.error(err);
    const status = Number(err.statusCode) || 500;
    return respond(status, { error: err.message });
  }
};

function normalizeFolderPrefix(prefix) {
  const trimmed = (prefix ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function userSub(event) {
  const sub = String(event.requestContext?.authorizer?.claims?.sub || "").trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(sub) ? sub : "";
}

function isMineRootPrefix(prefix, userId) {
  if (!userId) return false;
  const norm = normalizeFolderPrefix(prefix);
  return norm === `users/${userId}/`;
}

function isReservedTopFolder(prefix, userId) {
  const norm = normalizeFolderPrefix(prefix);
  if (RESERVED_SHARED_PREFIXES.includes(norm)) return true;
  if (!userId) return false;
  return RESERVED_SHARED_PREFIXES.some((name) => norm === `users/${userId}/${name}`);
}

async function ensureReservedFolders() {
  await Promise.all(RESERVED_SHARED_PREFIXES.map((key) => ensureFolderMarker(key)));
}

async function ensureUserLibraryFolders(userId) {
  if (!userId) return;
  const keys = [
    `users/${userId}/`,
    ...RESERVED_SHARED_PREFIXES.map((name) => `users/${userId}/${name}`),
  ];
  await Promise.all(keys.map((key) => ensureFolderMarker(key)));
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
                   hasImages: info.hasImages, hasSubFolders: info.hasSubFolders,
                   hasFiles: info.hasFiles };
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

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);

function isImageObjectKey(key) {
  const name = (key.split("/").pop() || "").toLowerCase();
  if (name === "captions.json") return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(name.slice(dot + 1));
}

async function getFolderInfo(prefix) {
  const { Contents, CommonPrefixes } = await client.send(
    new ListObjectsV2Command({ Bucket: PRIVATE_BUCKET, Prefix: prefix, Delimiter: "/" })
  );
  const directFiles = (Contents ?? []).filter((obj) => obj.Key !== prefix);
  return {
    hasMp3s:       directFiles.some((obj) => obj.Key.toLowerCase().endsWith(".mp3")),
    hasImages:     directFiles.some((obj) => isImageObjectKey(obj.Key)),
    hasSubFolders: (CommonPrefixes ?? []).length > 0,
    hasFiles:      directFiles.length > 0,
  };
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
}

function encodedCopySource(key) {
  return `${PRIVATE_BUCKET}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

async function copyObject(fromKey, destKey) {
  await client.send(new CopyObjectCommand({
    Bucket: PRIVATE_BUCKET,
    Key: destKey,
    CopySource: encodedCopySource(fromKey),
    MetadataDirective: "COPY",
  }));
}

async function prefixHasObjects(prefix) {
  const { Contents, KeyCount } = await client.send(new ListObjectsV2Command({
    Bucket: PRIVATE_BUCKET,
    Prefix: prefix,
    MaxKeys: 1,
  }));
  return Boolean(KeyCount) || (Contents ?? []).length > 0;
}

async function listPrefixKeys(prefix) {
  const keys = [];
  let continuationToken;
  do {
    const { Contents, IsTruncated, NextContinuationToken } = await client.send(
      new ListObjectsV2Command({
        Bucket: PRIVATE_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    continuationToken = IsTruncated ? NextContinuationToken : undefined;
    for (const obj of Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
  } while (continuationToken);
  return keys;
}

async function renameObject(fromKey, destKey) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: PRIVATE_BUCKET, Key: destKey }));
    const err = new Error("A file with that name already exists.");
    err.statusCode = 409;
    throw err;
  } catch (err) {
    if (err.statusCode === 409) throw err;
    const code = err.name || err.Code || "";
    const http = Number(err.$metadata?.httpStatusCode) || 0;
    if (code !== "NotFound" && http !== 404) throw err;
  }
  await copyObject(fromKey, destKey);
  await client.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: fromKey }));
  return destKey;
}

async function renamePrefix(fromPrefix, destPrefix) {
  const from = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
  const dest = destPrefix.endsWith("/") ? destPrefix : `${destPrefix}/`;
  if (await prefixHasObjects(dest)) {
    const err = new Error("A folder with that name already exists.");
    err.statusCode = 409;
    throw err;
  }
  const keys = await listPrefixKeys(from);
  if (!keys.length) {
    const err = new Error("Folder not found.");
    err.statusCode = 404;
    throw err;
  }
  for (const key of keys) {
    await copyObject(key, `${dest}${key.slice(from.length)}`);
  }
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket: PRIVATE_BUCKET,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }));
  }
  return dest;
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

function isSharePath(event) {
  const resource = String(event.resource || "");
  const path = String(event.path || "");
  return resource === "/files/share" || /\/files\/share\/?$/.test(path);
}

async function shareWithAll(event) {
  const body = JSON.parse(event.body ?? "{}");
  const claims = event.requestContext?.authorizer?.claims || {};
  const ownerFolder = shareOwnerFolderName({ ...claims, sub: userSub(event) || claims.sub });
  const plan = shareDestForKey(body.key, userSub(event), RESERVED_SHARED_PREFIXES, ownerFolder);
  if (plan.folder) await sharePrefix(plan.fromKey, plan.destKey, userSub(event));
  else await shareFile(plan.fromKey, plan.destKey, userSub(event));
  return respond(200, { key: plan.destKey, from: plan.fromKey, folder: plan.folder });
}

async function shareFile(fromKey, destKey, userId) {
  await assertDestAbsent(destKey, "A file with that name is already available to all DLIV users.");
  await copySharedObject(fromKey, destKey, userId);
}

async function sharePrefix(fromPrefix, destPrefix, userId) {
  const from = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
  const dest = destPrefix.endsWith("/") ? destPrefix : `${destPrefix}/`;
  if (await prefixHasObjects(dest)) {
    const err = new Error("A folder with that name is already available to all DLIV users.");
    err.statusCode = 409;
    throw err;
  }
  const keys = await listPrefixKeys(from);
  if (!keys.length) {
    const err = new Error("Folder not found.");
    err.statusCode = 404;
    throw err;
  }
  const contentsError = shareFolderContentsError(keys, from);
  if (contentsError) {
    const err = new Error(contentsError);
    err.statusCode = 400;
    throw err;
  }
  const copied = [];
  try {
    for (let i = 0; i < keys.length; i += SHARE_COPY_CONCURRENCY) {
      const batch = keys.slice(i, i + SHARE_COPY_CONCURRENCY);
      await Promise.all(batch.map(async (key) => {
        const destKey = `${dest}${key.slice(from.length)}`;
        await copySharedObject(key, destKey, userId);
        copied.push(destKey);
      }));
    }
  } catch (err) {
    try {
      await deleteKeysQuiet(copied);
    } catch (cleanupErr) {
      console.error(cleanupErr);
    }
    throw err;
  }
}

async function assertDestAbsent(destKey, message) {
  const found = await readSharedOwner(destKey);
  if (!found.missing) {
    const err = new Error(message);
    err.statusCode = 409;
    throw err;
  }
}

async function copySharedObject(fromKey, destKey, userId) {
  const found = await readObjectHead(fromKey);
  if (found.missing) {
    const err = new Error("File not found.");
    err.statusCode = 404;
    throw err;
  }
  const size = Number(found.head.ContentLength) || 0;
  if (size > MAX_SHARED_BYTES) {
    const err = new Error("Files larger than 5 GB cannot be shared.");
    err.statusCode = 400;
    throw err;
  }
  const input = {
    Bucket: PRIVATE_BUCKET,
    Key: destKey,
    CopySource: encodedCopySource(fromKey),
    MetadataDirective: "REPLACE",
    Metadata: metadataWithOwner(found.head.Metadata, userId),
    ContentType: found.head.ContentType || "application/octet-stream",
  };
  if (found.head.ContentDisposition) input.ContentDisposition = found.head.ContentDisposition;
  if (found.head.ContentEncoding) input.ContentEncoding = found.head.ContentEncoding;
  if (found.head.ContentLanguage) input.ContentLanguage = found.head.ContentLanguage;
  if (found.head.CacheControl) input.CacheControl = found.head.CacheControl;
  await client.send(new CopyObjectCommand(input));
}

async function assertCanRemoveSharedKey(key, userId) {
  if (!isSharedLibraryKey(key, RESERVED_SHARED_PREFIXES)) return;
  const found = await readSharedOwner(key);
  if (found.missing || mayRemoveSharedObject(found.owner, userId)) return;
  const err = new Error("Only the person who shared this file can remove it.");
  err.statusCode = 403;
  throw err;
}

async function assertCanRemoveSharedPrefix(prefix, userId) {
  const norm = normalizeFolderPrefix(prefix);
  if (!isSharedLibraryKey(norm, RESERVED_SHARED_PREFIXES)) return;
  const keys = await listPrefixKeys(norm);
  for (let i = 0; i < keys.length; i += 16) {
    const batch = keys.slice(i, i + 16);
    const owners = await Promise.all(batch.map((key) => readSharedOwner(key)));
    if (owners.some((found) => !found.missing && !mayRemoveSharedObject(found.owner, userId))) {
      const err = new Error("Only the person who shared these files can remove them.");
      err.statusCode = 403;
      throw err;
    }
  }
}

async function readSharedOwner(key) {
  const found = await readObjectHead(key);
  if (found.missing) return found;
  return { missing: false, owner: sharedOwnerFromMetadata(found.head.Metadata) };
}

async function readObjectHead(key) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
    return { missing: false, head };
  } catch (err) {
    if (isMissingObject(err)) return { missing: true, head: null, owner: "" };
    throw err;
  }
}

function isMissingObject(err) {
  const code = err.name || err.Code || "";
  const http = Number(err.$metadata?.httpStatusCode) || 0;
  return code === "NotFound" || code === "NoSuchKey" || http === 404;
}

async function deleteKeysQuiet(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (!chunk.length) continue;
    await client.send(new DeleteObjectsCommand({
      Bucket: PRIVATE_BUCKET,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }));
  }
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
