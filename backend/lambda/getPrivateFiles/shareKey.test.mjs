import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRenameInPersonalLibrary,
  assertUploadInOwnLibrary,
  isSharedLibraryKey,
  mayRemoveSharedObject,
  metadataWithOwner,
  shareDestForKey,
  shareFolderContentsError,
  shareOwnerFolderName,
  sharedOwnerFromMetadata,
} from "./shareKey.mjs";

const user = "11111111-2222-3333-4444-555555555555";
const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("a library file copies under the sharer's name", () => {
  const out = shareDestForKey(`users/${user}/Videos/Camping/clip.mp4`, user, undefined, "Wenner2026");
  assert.equal(out.destKey, "Videos/Wenner2026/Camping/clip.mp4");
  assert.equal(out.folder, false);
  assert.equal(out.library, "Videos");
  assert.equal(out.owner, "Wenner2026");
});

test("an album folder copies under the sharer's name", () => {
  const out = shareDestForKey(`users/${user}/Photos/Florence/`, user, undefined, "Wenner2026");
  assert.equal(out.destKey, "Photos/Wenner2026/Florence/");
  assert.equal(out.folder, true);
});

test("music nested under an album keeps that album", () => {
  const out = shareDestForKey(`users/${user}/Music/1973 Rupert/track.mp3`, user, undefined, "Wenner2026");
  assert.equal(out.destKey, "Music/Wenner2026/1973 Rupert/track.mp3");
});

test("a shared folder must contain files and no nested folders", () => {
  const prefix = `users/${user}/Photos/Florence/`;
  assert.equal(shareFolderContentsError([
    prefix,
    `${prefix}a.jpg`,
    `${prefix}b.jpg`,
  ], prefix), "");
  assert.match(shareFolderContentsError([
    prefix,
    `${prefix}Day1/a.jpg`,
  ], prefix), /folders inside it/);
  assert.match(shareFolderContentsError([
    prefix,
    `${prefix}a.jpg`,
    `${prefix}Day1/b.jpg`,
  ], prefix), /folders inside it/);
  assert.match(shareFolderContentsError([prefix], prefix), /no files/);
});

test("the sharer folder comes from the account name", () => {
  assert.equal(shareOwnerFolderName({ email: "Wenner2026@gmail.com" }), "Wenner2026");
  assert.equal(shareOwnerFolderName({ name: "Wenner 2026", email: "other@gmail.com" }), "Wenner 2026");
  assert.equal(shareOwnerFolderName({ sub: user }), user);
  assert.throws(() => shareOwnerFolderName({}), /needs a name/);
});

test("library roots and other people's files are rejected", () => {
  assert.throws(() => shareDestForKey(`users/${user}/Videos/`, user, undefined, "Wenner2026"), /inside the library/);
  assert.throws(() => shareDestForKey(`users/${other}/Videos/clip.mp4`, user, undefined, "Wenner2026"), /your library/);
  assert.throws(() => shareDestForKey(`users/${user}/Notes/a.txt`, user, undefined, "Wenner2026"), /Only Music, Photos, and Videos/);
  assert.throws(() => shareDestForKey(`users/${user}/Videos/clip.mp4`, "", undefined, "Wenner2026"), /Sign in required/);
  assert.throws(() => shareDestForKey(`users/${user}/Videos/clip.mp4`, user), /needs a name/);
});

test("shared library keys are the root Music, Photos, and Videos folders", () => {
  assert.equal(isSharedLibraryKey("Videos/clip.mp4"), true);
  assert.equal(isSharedLibraryKey("Photos/Florence/"), true);
  assert.equal(isSharedLibraryKey("Music/"), true);
  assert.equal(isSharedLibraryKey(`users/${user}/Videos/clip.mp4`), false);
  assert.equal(isSharedLibraryKey("Notes/a.txt"), false);
});

test("renames stay in a personal library", () => {
  assert.doesNotThrow(() => assertRenameInPersonalLibrary(`users/${user}/Photos/Trip/`));
  assert.throws(() => assertRenameInPersonalLibrary("Photos/Wenner2026/Trip/"), /your library/);
  assert.throws(() => assertRenameInPersonalLibrary("Videos/clip.mp4"), /your library/);
  assert.throws(() => assertRenameInPersonalLibrary("Notes/a.txt"), /your library/);
});

test("uploads stay in the caller's library", () => {
  assert.doesNotThrow(() => assertUploadInOwnLibrary(`users/${user}/Photos/Trip/a.jpg`, user));
  assert.throws(() => assertUploadInOwnLibrary("Photos/Trip/a.jpg", user), /your library/);
  assert.throws(() => assertUploadInOwnLibrary("Videos/", user), /your library/);
  assert.throws(() => assertUploadInOwnLibrary(`users/${other}/Videos/clip.mp4`, user), /your library/);
  assert.throws(() => assertUploadInOwnLibrary(`users/${user}/Photos/a.jpg`, ""), /Sign in required/);
});

test("owner metadata decides who can remove a shared copy", () => {
  assert.equal(sharedOwnerFromMetadata({ owner: user }), user);
  assert.equal(mayRemoveSharedObject("", other), true);
  assert.equal(mayRemoveSharedObject(user, user), true);
  assert.equal(mayRemoveSharedObject(user, other), false);
  assert.equal(metadataWithOwner({ title: "Camping" }, user).owner, user);
  assert.equal(metadataWithOwner({ title: "Camping" }, user).title, "Camping");
});
