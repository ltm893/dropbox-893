// backend/bin/config.example.ts
// ─────────────────────────────────────────────────────────────────────────────
// Copy this file to config.ts and fill in your values. config.ts is gitignored.
//
//   cp backend/bin/config.example.ts backend/bin/config.ts
//
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // id is read from the sibling cognito-s3-stack-893/base/bin/config.ts.
  // Set id here only to keep an already-deployed stack name.

  // AWS region to deploy into. Omit to use the base config region.
  awsRegion: "us-east-1",

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Cognito User Pool ID — from your cognito-s3-stack-893 base_outputs.json
  // or any existing pool.
  userPoolId: "us-east-1_XXXXXXXXX",

  // ── Storage ───────────────────────────────────────────────────────────────
  // S3 bucket for private files — must already exist, never created or deleted.
  privateBucket: "your-id-here-private",

  // S3 bucket for public slideshow photos — must already exist, never created or deleted.
  publicBucket: "your-id-here-public",

  // Optional: all slideshow folders live under this prefix (e.g. "images/").
  // Omit or "" if each album is a folder at the bucket root.
  publicSlideshowPrefix: "",

  // Top-level shared folders auto-created at bucket root; remove blocked, empty allowed.
  reservedSharedPrefixes: ["Music/", "Photos/", "Videos/"],
};
