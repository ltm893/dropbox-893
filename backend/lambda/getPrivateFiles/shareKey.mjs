const DEFAULT_LIBRARIES = ["Music/", "Photos/", "Videos/"];

export function shareOwnerFolderName(claims) {
  const c = claims || {};
  const named = c.name || c.given_name || c.preferred_username;
  const email = c.email || c["cognito:username"] || "";
  const fromEmail = String(email).includes("@") ? String(email).split("@")[0] : email;
  const raw = String(named || fromEmail || c.sub || "");
  const folder = raw
    .split(/[/\\]/).pop()
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/ {2,}/g, " ")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  if (!folder || folder === "." || folder === "..") {
    fail(400, "Your account needs a name before sharing.");
  }
  return folder;
}

export function shareDestForKey(fromKey, userId, libraries = DEFAULT_LIBRARIES, ownerFolder) {
  const raw = String(fromKey || "").replace(/^\/+/, "");
  const user = String(userId || "").trim();
  const owner = String(ownerFolder || "").trim();
  if (!user) fail(401, "Sign in required");
  if (!raw) fail(400, "Choose a file or folder to share.");
  if (!owner || owner.includes("/") || owner === "." || owner === "..") {
    fail(400, "Your account needs a name before sharing.");
  }
  const root = `users/${user}/`;
  if (!raw.startsWith(root)) fail(403, "You can only share files from your library.");
  const rest = raw.slice(root.length);
  const lib = libraries.find((name) => rest.startsWith(name));
  if (!lib) fail(400, "Only Music, Photos, and Videos can be shared with all DLIV users.");
  if (rest === lib) fail(400, "Choose a file or folder inside the library.");
  const folder = raw.endsWith("/");
  return {
    fromKey: raw,
    destKey: `${lib}${owner}/${rest.slice(lib.length)}`,
    folder,
    library: lib.slice(0, -1),
    owner,
  };
}

export function shareFolderContentsError(keys, prefix) {
  const from = String(prefix || "").endsWith("/") ? String(prefix || "") : `${prefix || ""}/`;
  const relative = (keys || [])
    .map((key) => String(key || ""))
    .filter((key) => key.startsWith(from) && key.length > from.length)
    .map((key) => key.slice(from.length));
  if (relative.some((name) => name.includes("/"))) {
    return "This folder has folders inside it. Share a folder that contains only files.";
  }
  if (!relative.some((name) => name && !name.endsWith("/"))) {
    return "This folder has no files to share.";
  }
  return "";
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

export function assertUploadInOwnLibrary(key, userId) {
  const user = String(userId || "").trim();
  if (!user) fail(401, "Sign in required");
  const raw = String(key || "").replace(/^\/+/, "");
  if (!raw.startsWith(`users/${user}/`)) {
    fail(403, "Add files and folders from your library. All DLIV Users shows shared copies.");
  }
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
