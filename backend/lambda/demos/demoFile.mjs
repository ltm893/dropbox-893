export const DEMO_PREFIX = "demos/";
const IMAGE_PDF_MAX = 30 * 1024 * 1024;
const MP4_MAX = 200 * 1024 * 1024;

const BY_EXT = {
  jpg: image("image/jpeg"),
  jpeg: image("image/jpeg"),
  png: image("image/png"),
  gif: image("image/gif"),
  webp: image("image/webp"),
  bmp: image("image/bmp"),
  avif: image("image/avif"),
  heic: image("image/heic"),
  heif: image("image/heif"),
  tif: image("image/tiff"),
  tiff: image("image/tiff"),
  pdf: { contentType: "application/pdf", kind: "pdf", max: IMAGE_PDF_MAX, limit: "Images and PDFs must be 30 MB or smaller." },
  mp4: { contentType: "video/mp4", kind: "mp4", max: MP4_MAX, limit: "MP4s must be 200 MB or smaller." },
};

const MIME_ALIASES = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/tif": "image/tiff",
  "image/x-png": "image/png",
  "image/x-ms-bmp": "image/bmp",
};

const TYPE_ERROR = "Use an image, a PDF, or an MP4.";

function image(contentType) {
  return { contentType, kind: "image", max: IMAGE_PDF_MAX, limit: "Images and PDFs must be 30 MB or smaller." };
}

function canonicalMime(mime) {
  const cleaned = String(mime || "").toLowerCase().split(";")[0].trim();
  if (!cleaned || cleaned === "application/octet-stream" || cleaned === "binary/octet-stream") return "";
  return MIME_ALIASES[cleaned] || cleaned;
}

export function extensionOf(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function safeDemoFilename(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  const ext = extensionOf(cleaned);
  const stem = ext ? cleaned.slice(0, -(ext.length + 1)) : cleaned;
  const safeStem = stem.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  const safeExt = BY_EXT[ext] ? ext : "";
  if (!safeStem || !safeExt) return "";
  return `${safeStem}.${safeExt}`;
}

export function planDemoUpload({ filename, contentType, size }) {
  const safe = safeDemoFilename(filename);
  const ext = extensionOf(safe);
  const spec = BY_EXT[ext];
  if (!safe || !spec) return { ok: false, error: TYPE_ERROR };
  const mime = canonicalMime(contentType);
  if (mime && mime !== spec.contentType) return { ok: false, error: TYPE_ERROR };
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: "Choose a file that is not empty." };
  if (bytes > spec.max) return { ok: false, error: spec.limit };
  return { ok: true, filename: safe, contentType: spec.contentType, kind: spec.kind, size: bytes };
}

export function demoObjectKey(filename, now = new Date(), id = "id") {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeId = String(id || "id").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "id";
  return `${DEMO_PREFIX}${stamp}-${safeId}/${filename}`;
}

export function publicDemoUrl(bucket, region, key) {
  const pathEncodedKey = key
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  if (String(bucket).includes(".")) {
    return `https://s3.${region}.amazonaws.com/${bucket}/${pathEncodedKey}`;
  }
  const legacyVirtualHostKey = encodeURIComponent(key).replace(/%2F/g, "/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${legacyVirtualHostKey}`;
}

export function demoViewFromKey(bucket, region, key, size, lastModified) {
  const full = String(key || "");
  if (!full.startsWith(DEMO_PREFIX) || full.endsWith("/")) return null;
  const rel = full.slice(DEMO_PREFIX.length);
  const parts = rel.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  const filename = parts[1];
  const spec = BY_EXT[extensionOf(filename)];
  if (!spec) return null;
  const when = lastModified ? new Date(lastModified).toISOString() : "";
  return {
    filename,
    url: publicDemoUrl(bucket, region, full),
    contentType: spec.contentType,
    kind: spec.kind,
    size: Number(size) || 0,
    lastModified: when,
  };
}
