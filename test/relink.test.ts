import { describe, expect, it } from "vitest";
import { buildIndex, matchTrack, movedPath, placeOf, relinkTree, remapKeys } from "../src/core/relink";
import type { CrateTree } from "../src/core/tree";

const index = buildIndex([
  "Pop/Super Song.mp3",
  "Rock/Loud.mp3",
  "Rock/Loud.flac",
  "Old/Archive/Loud.mp3",
  "Live/Encore.wav",
]);

describe("placeOf", () => {
  it("is the track's own path unless the root moved", () => {
    expect(placeOf("D:/Music", "Pop/Super Song.mp3")).toBe("Pop/Super Song.mp3");
    expect(placeOf("D:/Music", "D:/Music/Pop/Super Song.mp3")).toBe("Pop/Super Song.mp3");
    expect(placeOf("D:/Music", "C:/Other/Song.mp3")).toBeNull();
  });

  it("follows the root up, down and across drives", () => {
    expect(placeOf("D:/Music", "Pop/x.mp3", "D:/Music/Library")).toBe("Library/Pop/x.mp3");
    expect(placeOf("D:/Music/Library", "Library/Pop/x.mp3", "D:/Music")).toBe("Pop/x.mp3");
    expect(placeOf("E:/Music", "Pop/x.mp3", "D:/Music")).toBe("Pop/x.mp3");
  });
});

describe("matchTrack", () => {
  it("keeps a track that is where its path says, whatever the case", () => {
    expect(matchTrack("D:/Music", "pop\\SUPER SONG.MP3", index)).toEqual({ kind: "kept" });
  });

  it("relinks by file name when the track moved within the library", () => {
    expect(matchTrack("D:/Music", "Inbox/Super Song.mp3", index)).toEqual({
      kind: "moved",
      to: "Pop/Super Song.mp3",
    });
  });

  it("keeps a track when the whole library moved to another drive", () => {
    expect(matchTrack("E:/Music", "Pop/Super Song.mp3", index, "D:/Music")).toEqual({ kind: "kept" });
  });

  it("rewrites the path when the root moved one folder up and the file didn't", () => {
    const up = buildIndex(["Library/Pop/Super Song.mp3"]);
    expect(matchTrack("D:/Music", "Pop/Super Song.mp3", up, "D:/Music/Library")).toEqual({
      kind: "moved",
      to: "Library/Pop/Super Song.mp3",
    });
  });

  it("rewrites the path when the root moved one folder down", () => {
    expect(matchTrack("D:/Music/Library", "Library/Pop/Super Song.mp3", index, "D:/Music")).toEqual({
      kind: "moved",
      to: "Pop/Super Song.mp3",
    });
  });

  it("treats a different name as a different track", () => {
    expect(matchTrack("D:/Music", "Pop/Super Song Version 2.mp3", index)).toEqual({
      kind: "notFound",
    });
  });

  it("breaks a tie by the old relative place, then extension, then folder", () => {
    // Same relative place under the old root wins outright.
    expect(matchTrack("D:/Music", "Archive/Loud.mp3", index, "D:/Music/Old")).toEqual({
      kind: "moved",
      to: "Old/Archive/Loud.mp3",
    });
    // No place to go on: the same extension, then the same parent folder.
    expect(matchTrack("D:/Music", "Inbox/Loud.flac", index)).toEqual({
      kind: "moved",
      to: "Rock/Loud.flac",
    });
    expect(matchTrack("D:/Music", "Stale/Archive/Loud.mp3", index)).toEqual({
      kind: "moved",
      to: "Old/Archive/Loud.mp3",
    });
  });

  it("reports a tie it can't break, with every candidate", () => {
    expect(matchTrack("D:/Music", "Inbox/Loud.mp3", index)).toEqual({
      kind: "ambiguous",
      candidates: ["Rock/Loud.mp3", "Old/Archive/Loud.mp3"],
    });
  });
});

describe("relinkTree", () => {
  const tree: CrateTree = [
    {
      id: "a",
      name: "A",
      tracks: ["Pop/Super Song.mp3", "Gone/Encore.wav", "Nope.mp3"],
      children: [{ id: "b", name: "B", tracks: ["Gone/Encore.wav", "Inbox/Loud.mp3"], children: [] }],
    },
    { id: "c", name: "C", tracks: ["Rock/Loud.mp3"], children: [] },
  ];
  const plan = relinkTree("D:/Music", tree, index);

  it("rewrites moved tracks everywhere they appear and counts each once", () => {
    expect(plan.tree[0].tracks).toEqual(["Pop/Super Song.mp3", "Live/Encore.wav", "Nope.mp3"]);
    // "Rock/Loud.mp3" is held by crate C, so the stray "Loud.mp3" can only be the archived one.
    expect(plan.tree[0].children[0].tracks).toEqual(["Live/Encore.wav", "Old/Archive/Loud.mp3"]);
    expect({ kept: plan.kept, moved: plan.moved, ambiguous: plan.ambiguous, notFound: plan.notFound }).toEqual({
      kept: 2,
      moved: 2,
      ambiguous: 0,
      notFound: 1,
    });
    expect(plan.moves.get("gone/encore.wav")).toBe("Live/Encore.wav");
    expect(plan.moves.get("inbox/loud.mp3")).toBe("Old/Archive/Loud.mp3");
    expect(plan.unresolved.get("nope.mp3")).toEqual({ kind: "notFound" });
  });

  it("never relinks a missing track onto a file another member already holds", () => {
    const two = buildIndex(["Pop/Intro.mp3"]);
    const crates: CrateTree = [{ id: "a", name: "A", tracks: ["Pop/Intro.mp3", "Rock/Intro.mp3"], children: [] }];
    const result = relinkTree("D:/Music", crates, two);
    expect(result.tree).toBe(crates);
    expect(result.kept).toBe(1);
    expect(result.unresolved.get("rock/intro.mp3")).toEqual({ kind: "notFound" });
    // Without a member in place, the file is free to be matched.
    expect(matchTrack("D:/Music", "Rock/Intro.mp3", two)).toEqual({ kind: "moved", to: "Pop/Intro.mp3" });
  });

  it("rewrites every path when the library moved one folder up", () => {
    const up = buildIndex(["Library/Pop/Super Song.mp3", "Library/Rock/Loud.mp3"]);
    const crates: CrateTree = [
      { id: "a", name: "A", tracks: ["Pop/Super Song.mp3", "Rock/Loud.mp3"], children: [] },
    ];
    const result = relinkTree("D:/Music", crates, up, "D:/Music/Library");
    expect(result.tree[0].tracks).toEqual(["Library/Pop/Super Song.mp3", "Library/Rock/Loud.mp3"]);
    expect(result.moved).toBe(2);
  });

  it("leaves untouched crates as the same objects", () => {
    expect(plan.tree[1]).toBe(tree[1]);
    expect(plan.tree[0]).not.toBe(tree[0]);
  });

  it("returns the very same tree when nothing moved", () => {
    const same = relinkTree("D:/Music", plan.tree, index);
    expect(same.tree).toBe(plan.tree);
    expect(same.moved).toBe(0);
  });
});

describe("remapKeys", () => {
  it("carries per-track records over to the new paths", () => {
    const moves = new Map([["gone/encore.wav", "Live/Encore.wav"]]);
    expect(remapKeys({ "gone/encore.wav": { duration: 42 }, "x.mp3": { duration: 7 } }, moves)).toEqual({
      "live/encore.wav": { duration: 42 },
      "x.mp3": { duration: 7 },
    });
    expect(movedPath("Gone\\Encore.wav", moves)).toBe("Live/Encore.wav");
    expect(movedPath("x.mp3", moves)).toBe("x.mp3");
  });
});
