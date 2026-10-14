'use strict';
console.log('Loading sharedAlbums function');

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const client = new S3Client({});
const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET;
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const SHARED_ROOT = "shared/";
const MAX_PHOTOS = 250;
const COPY_CONCURRENCY = 8;
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);
const CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

export const handler = async (event) => {
  const method = event.httpMethod;
  const resource = event.resource || "";
  const owner = event.pathParameters?.owner;
  const slug = event.pathParameters?.slug;

  try {
    if (method === "GET" && resource.endsWith("/mine")) {
      return await listMine(event);
    }
    if (method === "GET" && owner && slug) {
      return await getAlbum(owner, slug);
    }
    if (method === "GET") {
      return await listPublic();
    }
    if (method === "POST" && /\/photos$/.test(resource)) {
      return await addPhotos(event, owner, slug);
    }
    if (method === "POST") {
      return await publishAlbum(event);
    }
    if (method === "DELETE" && owner && slug && (event.pathParameters?.filename || /\/photos$/.test(resource))) {
      return await removePhotos(event, owner, slug);
    }
    if (method === "DELETE" && owner && slug) {
      return await unpublishAlbum(event, owner, slug);
    }
    return respond(405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    const status = Number(err.statusCode) || 500;
    return respond(status, { error: err.message || "Shared album failed" });
  }
};

function claimsFrom(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const ownerId = claims.sub;
  if (!ownerId) {
    const err = new Error("Sign in required");
    err.statusCode = 401;
    throw err;
  }
  const email = claims.email || claims["cognito:username"] || "";
  const ownerLabel =
    claims.name ||
    claims.given_name ||
    claims.preferred_username ||
    (email.includes("@") ? email.split("@")[0] : email) ||
    ownerId;
  return { ownerId, ownerLabel };
}

async function listPublic() {
  const albums = await listAllAlbums();
  return respond(200, {
    albums: albums
      .map(publicAlbumView)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
  });
}

async function listMine(event) {
  const { ownerId } = claimsFrom(event);
  const albums = await listOwnerAlbums(ownerId);
  return respond(200, {
    albums: albums
      .map((a) => ({ ...publicAlbumView(a), sourcePrefix: a.sourcePrefix || "" }))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
  });
}

async function getAlbum(owner, slug) {
  const manifest = await readManifest(owner, slug);
  if (!manifest) return respond(404, { error: "Slideshow not found" });
  const prefix = albumPrefix(owner, slug);
  const photos = await listPublicPhotos(prefix);
  const captions = await readCaptions(PUBLIC_BUCKET, `${prefix}captions.json`);
  return respond(200, {
    album: publicAlbumView(manifest),
    photos: photos.map((p) => ({
      ...p,
      caption: captions[p.filename] || "",
    })),
  });
}

async function publishAlbum(event) {
  const { ownerId, ownerLabel: tokenLabel } = claimsFrom(event);
  const body = parseBody(event.body);
  const keys = normalizeKeys(body.keys);
  if (keys.length) {
    return await writeAlbumFromKeys({
      ownerId,
      ownerLabel: String(body.ownerLabel || tokenLabel).trim().slice(0, 80) || tokenLabel,
      title: String(body.title || folderNameFromPrefix(prefixOfKey(keys[0])) || "Slideshow").trim().slice(0, 80),
      keys,
    });
  }
  const prefix = normalizeFolderPrefix(body.prefix);
  if (!prefix) {
    return respond(400, { error: "keys or prefix is required" });
  }
  const images = await listPrivateImages(prefix);
  if (!images.length) {
    return respond(400, { error: "No photos in this folder" });
  }
  if (images.length > MAX_PHOTOS) {
    return respond(400, { error: `Folder has ${images.length} photos; max is ${MAX_PHOTOS}` });
  }
  return await writeAlbumFromKeys({
    ownerId,
    ownerLabel: String(body.ownerLabel || tokenLabel).trim().slice(0, 80) || tokenLabel,
    title: String(body.title || folderNameFromPrefix(prefix) || "Slideshow").trim().slice(0, 80),
    keys: images.map((img) => img.key),
    sourcePrefix: prefix,
    replaceAll: true,
  });
}

async function addPhotos(event, owner, slug) {
  const { ownerId, ownerLabel: tokenLabel } = claimsFrom(event);
  if (ownerId !== owner) {
    return respond(403, { error: "Only the publisher can add photos to this slideshow" });
  }
  const manifest = await readManifest(owner, slug);
  if (!manifest) return respond(404, { error: "Slideshow not found" });
  const body = parseBody(event.body);
  const keys = normalizeKeys(body.keys);
  if (!keys.length) return respond(400, { error: "keys is required" });
  if (keys.length > MAX_PHOTOS) {
    return respond(400, { error: `Too many photos; max is ${MAX_PHOTOS}` });
  }
  const destPrefix = albumPrefix(owner, slug);
  const currentCount = Number(manifest.photoCount) || (await listPublicPhotos(destPrefix)).length;
  if (currentCount + keys.length > MAX_PHOTOS) {
    return respond(400, { error: `Slideshow would exceed ${MAX_PHOTOS} photos` });
  }
  const result = await copyKeysIntoAlbum({
    destPrefix,
    keys,
    sources: { ...(manifest.sources || {}) },
  });
  const now = new Date().toISOString();
  const next = {
    ...manifest,
    ownerLabel: String(body.ownerLabel || manifest.ownerLabel || tokenLabel).trim().slice(0, 80) || tokenLabel,
    photoCount: result.photoCount,
    sources: result.sources,
    updatedAt: now,
    createdAt: manifest.createdAt || now,
  };
  await putJson(PUBLIC_BUCKET, `${destPrefix}manifest.json`, next);
  return respond(200, {
    album: { ...publicAlbumView(next), sourcePrefix: next.sourcePrefix || "" },
    added: result.added,
    skipped: result.skipped,
  });
}

async function writeAlbumFromKeys({
  ownerId,
  ownerLabel,
  title,
  keys,
  sourcePrefix = "",
  replaceAll = false,
}) {
  if (keys.length > MAX_PHOTOS) {
    return respond(400, { error: `Too many photos; max is ${MAX_PHOTOS}` });
  }
  const mine = await listOwnerAlbums(ownerId);
  const existing = sourcePrefix
    ? mine.find((a) => a.sourcePrefix === sourcePrefix)
    : null;
  const slug = existing?.slug || uniqueSlug(title, ownerId, mine);
  const destPrefix = albumPrefix(ownerId, slug);
  const copied = await copyKeysIntoAlbum({
    destPrefix,
    keys,
    sources: { ...(existing?.sources || {}) },
    replaceAll: replaceAll || !existing,
  });
  const now = new Date().toISOString();
  const manifest = {
    id: `${ownerId}/${slug}`,
    slug,
    title,
    ownerId,
    ownerLabel,
    sourcePrefix: sourcePrefix || existing?.sourcePrefix || "",
    photoCount: copied.photoCount,
    sources: copied.sources,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await putJson(PUBLIC_BUCKET, `${destPrefix}manifest.json`, manifest);
  return respond(200, { album: { ...publicAlbumView(manifest), sourcePrefix: manifest.sourcePrefix || "" } });
}

async function copyKeysIntoAlbum({ destPrefix, keys, sources = {}, replaceAll = false }) {
  const existingPhotos = await listPublicPhotos(destPrefix);
  const usedNames = new Set(existingPhotos.map((p) => p.filename));
  const nextSources = replaceAll ? {} : { ...sources };
  if (replaceAll) usedNames.clear();
  const added = [];
  const skipped = [];
  const captionOut = replaceAll ? {} : await readCaptions(PUBLIC_BUCKET, `${destPrefix}captions.json`);

  for (const key of keys) {
    const filename = fileNameFromKey(key);
    if (!isImageName(filename)) {
      skipped.push(key);
      continue;
    }
    const already = Object.entries(nextSources).find(([, src]) => src === key);
    if (already) {
      skipped.push(key);
      continue;
    }
    const destName = uniqueFilename(filename, usedNames);
    usedNames.add(destName);
    nextSources[destName] = key;
    await client.send(
      new CopyObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: `${destPrefix}${destName}`,
        CopySource: copySource(PRIVATE_BUCKET, key),
        ContentType: contentTypeFor(destName),
        MetadataDirective: "REPLACE",
      })
    );
    const srcCaptions = await readCaptions(PRIVATE_BUCKET, `${prefixOfKey(key)}captions.json`);
    if (srcCaptions[filename]) captionOut[destName] = srcCaptions[filename];
    added.push(destName);
  }

  await putJson(PUBLIC_BUCKET, `${destPrefix}captions.json`, {
    version: 1,
    captions: captionOut,
  });

  if (replaceAll) {
    const destObjects = await listAllKeys(PUBLIC_BUCKET, destPrefix);
    const keep = new Set([
      `${destPrefix}manifest.json`,
      `${destPrefix}captions.json`,
      ...[...usedNames].map((name) => `${destPrefix}${name}`),
    ]);
    await deleteKeys(PUBLIC_BUCKET, destObjects.filter((k) => !keep.has(k)));
  }

  const photos = await listPublicPhotos(destPrefix);
  return {
    added,
    skipped,
    sources: nextSources,
    photoCount: photos.length,
  };
}

function normalizeKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((k) => String(k || "").trim()).filter(Boolean))];
}

function fileNameFromKey(key) {
  return String(key || "").split("/").pop() || "";
}

function prefixOfKey(key) {
  const name = fileNameFromKey(key);
  if (!name || name === key) return "";
  return String(key).slice(0, key.length - name.length);
}

function uniqueFilename(filename, used) {
  if (!used.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : "";
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

async function removePhotos(event, owner, slug) {
  const { ownerId } = claimsFrom(event);
  if (ownerId !== owner) {
    return respond(403, { error: "Only the publisher can remove photos from this slideshow" });
  }
  const manifest = await readManifest(owner, slug);
  if (!manifest) return respond(404, { error: "Slideshow not found" });
  const body = parseBody(event.body);
  const fromPath = decodePathParam(event.pathParameters?.filename);
  const names = [
    ...normalizeKeys(body.filenames),
    ...normalizeKeys(fromPath ? [fromPath] : []),
  ].map((name) => fileNameFromKey(name)).filter(Boolean);
  const unique = [...new Set(names)];
  if (!unique.length) return respond(400, { error: "filename is required" });
  const destPrefix = albumPrefix(owner, slug);
  const photos = await listPublicPhotos(destPrefix);
  const present = new Set(photos.map((p) => p.filename));
  const toDelete = unique.filter((name) => present.has(name));
  if (!toDelete.length) return respond(404, { error: "Photo not found in this slideshow" });
  await deleteKeys(PUBLIC_BUCKET, toDelete.map((name) => `${destPrefix}${name}`));
  const captions = await readCaptions(PUBLIC_BUCKET, `${destPrefix}captions.json`);
  const sources = { ...(manifest.sources || {}) };
  for (const name of toDelete) {
    delete captions[name];
    delete sources[name];
  }
  await putJson(PUBLIC_BUCKET, `${destPrefix}captions.json`, {
    version: 1,
    captions,
  });
  const remaining = await listPublicPhotos(destPrefix);
  const now = new Date().toISOString();
  const next = {
    ...manifest,
    sources,
    photoCount: remaining.length,
    updatedAt: now,
    createdAt: manifest.createdAt || now,
  };
  await putJson(PUBLIC_BUCKET, `${destPrefix}manifest.json`, next);
  return respond(200, {
    album: { ...publicAlbumView(next), sourcePrefix: next.sourcePrefix || "" },
    removed: toDelete,
  });
}

function decodePathParam(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function unpublishAlbum(event, owner, slug) {
  const { ownerId } = claimsFrom(event);
  if (ownerId !== owner) {
    return respond(403, { error: "Only the publisher can unpublish this slideshow" });
  }
  const manifest = await readManifest(owner, slug);
  if (!manifest) return respond(404, { error: "Slideshow not found" });
  const keys = await listAllKeys(PUBLIC_BUCKET, albumPrefix(owner, slug));
  await deleteKeys(PUBLIC_BUCKET, keys);
  return respond(200, { deleted: manifest.id });
}

function publicAlbumView(album) {
  return {
    id: album.id,
    slug: album.slug,
    title: album.title,
    ownerId: album.ownerId,
    ownerLabel: album.ownerLabel || "",
    photoCount: album.photoCount || 0,
    createdAt: album.createdAt || "",
    updatedAt: album.updatedAt || "",
  };
}

async function listAllAlbums() {
  const owners = await listCommonPrefixes(PUBLIC_BUCKET, SHARED_ROOT);
  const albums = [];
  for (const ownerPrefix of owners) {
    const ownerId = ownerPrefix.slice(SHARED_ROOT.length).replace(/\/$/, "");
    albums.push(...(await listOwnerAlbums(ownerId)));
  }
  return albums;
}

async function listOwnerAlbums(ownerId) {
  const prefixes = await listCommonPrefixes(PUBLIC_BUCKET, `${SHARED_ROOT}${ownerId}/`);
  const albums = [];
  for (const prefix of prefixes) {
    const slug = prefix.slice(`${SHARED_ROOT}${ownerId}/`.length).replace(/\/$/, "");
    const manifest = await readManifest(ownerId, slug);
    if (manifest) albums.push(manifest);
  }
  return albums;
}

async function readManifest(ownerId, slug) {
  const data = await readJson(PUBLIC_BUCKET, `${albumPrefix(ownerId, slug)}manifest.json`);
  if (!data || typeof data !== "object") return null;
  return {
    ...data,
    id: `${ownerId}/${slug}`,
    slug,
    ownerId,
  };
}

async function listPrivateImages(prefix) {
  const { Contents } = await client.send(
    new ListObjectsV2Command({
      Bucket: PRIVATE_BUCKET,
      Prefix: prefix,
      Delimiter: "/",
    })
  );
  return (Contents ?? [])
    .map((obj) => {
      const key = obj.Key;
      const filename = key.slice(prefix.length);
      return { key, filename };
    })
    .filter((img) => img.filename && !img.filename.includes("/") && isImageName(img.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" }));
}

async function listPublicPhotos(prefix) {
  const keys = await listAllKeys(PUBLIC_BUCKET, prefix);
  return keys
    .map((key) => ({ key, filename: key.slice(prefix.length) }))
    .filter((p) => p.filename && !p.filename.includes("/") && isImageName(p.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" }))
    .map((p) => ({
      key: p.key,
      filename: p.filename,
      url: objectPublicGETUrl(PUBLIC_BUCKET, REGION, p.key),
    }));
}

async function readCaptions(bucket, key) {
  const data = await readJson(bucket, key);
  if (!data || typeof data !== "object") return {};
  const raw = data.captions && typeof data.captions === "object" ? data.captions : data;
  const map = {};
  for (const [name, text] of Object.entries(raw)) {
    if (name === "version") continue;
    if (typeof text === "string" && text.trim()) map[name] = text.trim();
  }
  return map;
}

async function listCommonPrefixes(bucket, prefix) {
  const prefixes = [];
  let token;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      })
    );
    for (const p of resp.CommonPrefixes ?? []) {
      if (p.Prefix) prefixes.push(p.Prefix);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return prefixes;
}

async function listAllKeys(bucket, prefix) {
  const keys = [];
  let token;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.Key !== prefix) keys.push(obj.Key);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (!chunk.length) continue;
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      })
    );
  }
}

async function readJson(bucket, key) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (err.name === "NoSuchKey" || status === 404) return null;
    throw err;
  }
}

async function putJson(bucket, key, body) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    })
  );
}

function uniqueSlug(title, ownerId, existing) {
  const base = slugify(title);
  const taken = new Set(existing.map((a) => a.slug));
  if (!taken.has(base)) return base;
  const suffix = String(ownerId).replace(/-/g, "").slice(-6);
  let slug = `${base}-${suffix}`;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${suffix}-${n}`;
    n += 1;
  }
  return slug;
}

function slugify(name) {
  const s = String(name || "slideshow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "slideshow";
}

function albumPrefix(ownerId, slug) {
  return `${SHARED_ROOT}${ownerId}/${slug}/`;
}

function folderNameFromPrefix(prefix) {
  const parts = String(prefix || "").replace(/\/$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function normalizeFolderPrefix(prefix) {
  const trimmed = String(prefix ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isImageName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "captions.json" || lower === "manifest.json") return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(lower.slice(dot + 1));
}

function contentTypeFor(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function copySource(bucket, key) {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

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

async function mapPool(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length) || 0;
  await Promise.all(Array.from({ length: n }, worker));
  return ret;
}

function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
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
