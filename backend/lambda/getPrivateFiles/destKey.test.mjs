import { test } from "node:test";
import assert from "node:assert/strict";
import { destKeyForRename } from "./destKey.mjs";

test("file rename stays in the same folder and keeps the extension", () => {
  const out = destKeyForRename("users/x/Videos/DVD-copy.mp4", "Camping");
  assert.equal(out.destKey, "users/x/Videos/Camping.mp4");
  assert.equal(out.folder, false);
});

test("folder rename keeps the parent and a trailing slash", () => {
  const out = destKeyForRename("users/x/Music/CD20261001-1/", "1973 Rupert Held Phone");
  assert.equal(out.destKey, "users/x/Music/1973 Rupert Held Phone/");
  assert.equal(out.folder, true);
  assert.equal(out.name, "1973 Rupert Held Phone");
});
