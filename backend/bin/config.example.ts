// backend/bin/config.example.ts
// ─────────────────────────────────────────────────────────────────────────────
// Copy this file to config.ts and fill in your values. config.ts is gitignored.
//
//   cp backend/bin/config.example.ts backend/bin/config.ts
//
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // Short prefix for all AWS resource names.
  // Lowercase letters, numbers, hyphens only.
  id: "your-id-here",

  // AWS region to deploy into.
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
};
