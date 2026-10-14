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

function fileExtension(name) {
  const base = String(name || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : "";
}
