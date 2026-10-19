import { test } from "node:test";
import assert from "node:assert/strict";
import { destKeyForMove, destKeyForRename } from "./destKey.mjs";

test("file rename stays in the same folder and keeps the extension", () => {
  const out = destKeyForRename("users/x/Videos/DVD-copy.mp4", "Camping");
  assert.equal(out.destKey, "users/x/Videos/Camping.mp4");
  assert.equal(out.folder, false);
});

test("a file in the home library moves into another folder and keeps its name", () => {
  const user = "11111111-2222-3333-4444-555555555555";
  const from = `users/${user}/Videos/TaylorsGang/clip.mp4`;
  const out = destKeyForMove(from, `users/${user}/Photos/Trip/`, user);
  assert.equal(out.destKey, `users/${user}/Photos/Trip/clip.mp4`);
  assert.equal(out.folder, false);
  const home = destKeyForMove(`users/${user}/notes.txt`, `users/${user}/`, user);
  assert.equal(home.unchanged, true);
  const same = destKeyForMove(from, `users/${user}/Videos/TaylorsGang/`, user);
  assert.equal(same.unchanged, true);
});

test("library roots and other libraries cannot be moved", () => {
  const user = "11111111-2222-3333-4444-555555555555";
  assert.throws(() => destKeyForMove(`users/${user}/Videos/`, `users/${user}/Photos/`, user), /stays where it is/);
  assert.throws(() => destKeyForMove(`users/${user}/Videos/TaylorsGang/`, `users/${user}/Videos/TaylorsGang/Inside/`, user), /not inside this one/);
  assert.throws(() => destKeyForMove("Videos/clip.mp4", `users/${user}/Photos/`, user), /your library/);
  assert.throws(() => destKeyForMove(`users/${user}/Videos/clip.mp4`, "Photos/Trip/", user), /your library/);
});

test("folder rename keeps the parent and a trailing slash", () => {
  const out = destKeyForRename("users/x/Music/CD20261001-1/", "1973 Rupert Held Phone");
  assert.equal(out.destKey, "users/x/Music/1973 Rupert Held Phone/");
  assert.equal(out.folder, true);
  assert.equal(out.name, "1973 Rupert Held Phone");
});
