export function destKeyForRename(fromKey, typedName) {
  const raw = String(fromKey || "").replace(/^\/+/, "");
  if (!raw) {
    const err = new Error("Choose a file to rename.");
    err.statusCode = 400;
    throw err;
  }
  const folder = raw.endsWith("/");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) {
    const err = new Error(folder ? "Choose a folder to rename." : "Choose a file to rename.");
    err.statusCode = 400;
    throw err;
  }
  const oldName = parts.pop() || "";
  const oldExt = folder ? "" : fileExtension(oldName);
  let name = String(typedName || "").split(/[/\\]/).pop() || "";
  name = name.replace(/[\u0000-\u001f]/g, "").trim();
  if (!name) {
    const err = new Error(folder ? "Enter a folder name." : "Enter a file name.");
    err.statusCode = 400;
    throw err;
  }
  if (!folder && !fileExtension(name) && oldExt) name = `${name}.${oldExt}`;
  name = name
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/ {2,}/g, " ")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!name) {
    const err = new Error(folder ? "Enter a folder name." : "Enter a file name.");
    err.statusCode = 400;
    throw err;
  }
  name = name.slice(0, 180);
  const destKey = folder ? `${[...parts, name].join("/")}/` : [...parts, name].join("/");
  const fromNorm = folder ? (raw.endsWith("/") ? raw : `${raw}/`) : raw;
  return { fromKey: fromNorm, destKey, name, unchanged: destKey === fromNorm, folder };
}

export function destKeyForMove(fromKey, destPrefix, userId) {
  const raw = String(fromKey || "").replace(/^\/+/, "");
  const user = String(userId || "").trim();
  if (!user) fail(401, "Sign in required");
  if (!raw) fail(400, "Choose a file or folder to move.");
  const home = `users/${user}/`;
  if (!raw.startsWith(home)) fail(403, "Move files and folders from your library.");
  const folder = raw.endsWith("/");
  const fromNorm = raw;
  const reserved = ["Music/", "Photos/", "Videos/"].map((name) => `${home}${name}`);
  if (fromNorm === home || (folder && reserved.includes(fromNorm))) {
    fail(400, "That folder stays where it is.");
  }
  let dest = String(destPrefix || "").replace(/^\/+/, "").trim();
  if (!dest) fail(400, "Choose a folder in your library.");
  if (!dest.endsWith("/")) dest += "/";
  if (!dest.startsWith(home) || dest.split("/").some((part) => part === "." || part === "..")) {
    fail(403, "Choose a folder in your library.");
  }
  if (folder && (dest === fromNorm || dest.startsWith(fromNorm))) {
    fail(400, "Choose a folder that is not inside this one.");
  }
  const base = fromNorm.split("/").filter(Boolean).pop() || "";
  const destKey = folder ? `${dest}${base}/` : `${dest}${base}`;
  return { fromKey: fromNorm, destKey, name: base, folder, unchanged: destKey === fromNorm };
}

function fail(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

function fileExtension(name) {
  const base = String(name || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : "";
}
