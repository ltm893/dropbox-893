const DEFAULT_LIBRARIES = ["Music/", "Photos/", "Videos/"];

export function shareDestForKey(fromKey, userId, libraries = DEFAULT_LIBRARIES) {
  const raw = String(fromKey || "").replace(/^\/+/, "");
  const user = String(userId || "").trim();
  if (!user) fail(401, "Sign in required");
  if (!raw) fail(400, "Choose a file or folder to share.");
  const root = `users/${user}/`;
  if (!raw.startsWith(root)) fail(403, "You can only share files from your library.");
  const rest = raw.slice(root.length);
  const lib = libraries.find((name) => rest.startsWith(name));
  if (!lib) fail(400, "Only Music, Photos, and Videos can be shared with all DLIV users.");
  if (rest === lib) fail(400, "Choose a file or folder inside the library.");
  const folder = raw.endsWith("/");
  return {
    fromKey: raw,
    destKey: rest,
    folder,
    library: lib.slice(0, -1),
  };
}

export function isSharedLibraryKey(key, libraries = DEFAULT_LIBRARIES) {
  const raw = String(key || "").replace(/^\/+/, "");
  if (!raw || raw.startsWith("users/")) return false;
  return libraries.some((name) => raw === name || raw.startsWith(name));
}

export function sharedOwnerFromMetadata(metadata) {
  const meta = metadata || {};
  return String(meta.owner || meta.Owner || "").trim();
}

export function metadataWithOwner(existing, userId) {
  const metadata = {};
  for (const [key, value] of Object.entries(existing || {})) {
    if (typeof value === "string") metadata[key] = value;
  }
  metadata.owner = String(userId || "");
  return metadata;
}

export function mayRemoveSharedObject(owner, userId) {
  if (!owner) return true;
  return owner === userId;
}

function fail(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}
