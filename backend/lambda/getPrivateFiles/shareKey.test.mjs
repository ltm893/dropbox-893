import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSharedLibraryKey,
  mayRemoveSharedObject,
  metadataWithOwner,
  shareDestForKey,
  sharedOwnerFromMetadata,
} from "./shareKey.mjs";

const user = "11111111-2222-3333-4444-555555555555";
const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("a library file copies to the matching shared path", () => {
  const out = shareDestForKey(`users/${user}/Videos/Camping/clip.mp4`, user);
  assert.equal(out.destKey, "Videos/Camping/clip.mp4");
  assert.equal(out.folder, false);
  assert.equal(out.library, "Videos");
});

test("an album folder copies to the same shared prefix", () => {
  const out = shareDestForKey(`users/${user}/Photos/Florence/`, user);
  assert.equal(out.destKey, "Photos/Florence/");
  assert.equal(out.folder, true);
});

test("music nested under an album keeps that album", () => {
  const out = shareDestForKey(`users/${user}/Music/1973 Rupert/track.mp3`, user);
  assert.equal(out.destKey, "Music/1973 Rupert/track.mp3");
});

test("library roots and other people's files are rejected", () => {
  assert.throws(() => shareDestForKey(`users/${user}/Videos/`, user), /inside the library/);
  assert.throws(() => shareDestForKey(`users/${other}/Videos/clip.mp4`, user), /your library/);
  assert.throws(() => shareDestForKey(`users/${user}/Notes/a.txt`, user), /Only Music, Photos, and Videos/);
  assert.throws(() => shareDestForKey(`users/${user}/Videos/clip.mp4`, ""), /Sign in required/);
});

test("shared library keys are the root Music, Photos, and Videos folders", () => {
  assert.equal(isSharedLibraryKey("Videos/clip.mp4"), true);
  assert.equal(isSharedLibraryKey("Photos/Florence/"), true);
  assert.equal(isSharedLibraryKey("Music/"), true);
  assert.equal(isSharedLibraryKey(`users/${user}/Videos/clip.mp4`), false);
  assert.equal(isSharedLibraryKey("Notes/a.txt"), false);
});

test("owner metadata decides who can remove a shared copy", () => {
  assert.equal(sharedOwnerFromMetadata({ owner: user }), user);
  assert.equal(mayRemoveSharedObject("", other), true);
  assert.equal(mayRemoveSharedObject(user, user), true);
  assert.equal(mayRemoveSharedObject(user, other), false);
  assert.equal(metadataWithOwner({ title: "Camping" }, user).owner, user);
  assert.equal(metadataWithOwner({ title: "Camping" }, user).title, "Camping");
});
