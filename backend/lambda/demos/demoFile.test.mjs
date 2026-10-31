import { test } from "node:test";
import assert from "node:assert/strict";
import { demoObjectKey, demoViewFromKey, planDemoUpload, publicDemoUrl } from "./demoFile.mjs";

test("accepts an image, a PDF, or an MP4 and rejects other files", () => {
  assert.equal(planDemoUpload({ filename: "Photo.PNG", contentType: "image/png", size: 12 }).ok, true);
  assert.equal(planDemoUpload({ filename: "notes.pdf", contentType: "application/pdf", size: 12 }).contentType, "application/pdf");
  assert.equal(planDemoUpload({ filename: "clip.mp4", contentType: "video/mp4", size: 12 }).kind, "mp4");
  assert.equal(planDemoUpload({ filename: "clip.mov", contentType: "video/quicktime", size: 12 }).ok, false);
  assert.equal(planDemoUpload({ filename: "page.html", contentType: "text/html", size: 12 }).ok, false);
  assert.equal(planDemoUpload({ filename: "icon.svg", contentType: "image/svg+xml", size: 12 }).ok, false);
  assert.equal(planDemoUpload({ filename: "notes.pdf", contentType: "text/plain", size: 12 }).ok, false);
  assert.match(planDemoUpload({ filename: "a.png", contentType: "image/png", size: 0 }).error, /not empty/);
  assert.match(planDemoUpload({ filename: "a.mp4", contentType: "video/mp4", size: 201 * 1024 * 1024 }).error, /200 MB/);
});

test("stores the file under demos and ignores anything else", () => {
  const key = demoObjectKey("photo.png", new Date("2026-10-31T12:00:00.000Z"), "ab12");
  assert.equal(key, "demos/20261031T120000Z-ab12/photo.png");
  const view = demoViewFromKey("dliv-public", "us-east-1", key, 24, "2026-10-31T12:00:00.000Z");
  assert.equal(view.filename, "photo.png");
  assert.equal(view.kind, "image");
  assert.equal(view.url, "https://dliv-public.s3.us-east-1.amazonaws.com/demos/20261031T120000Z-ab12/photo.png");
  assert.equal(demoViewFromKey("dliv-public", "us-east-1", "images/album/a.png", 1, ""), null);
  assert.equal(demoViewFromKey("dliv-public", "us-east-1", "demos/../secret.png", 1, ""), null);
  assert.equal(demoViewFromKey("dliv.com-public", "us-east-1", key, 1, "").url.startsWith("https://s3.us-east-1.amazonaws.com/dliv.com-public/"), true);
  assert.match(publicDemoUrl("dliv-public", "us-east-1", key), /^https:\/\/dliv-public\.s3\./);
});
