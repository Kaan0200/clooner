import { describe, expect, it } from "vitest";
import { buildIndex, matchTrack, movedPath, relinkTree, remapDurations } from "../src/core/relink";
import type { CrateTree } from "../src/core/tree";

const index = buildIndex([
  "Pop/Super Song.mp3",
  "Rock/Loud.mp3",
  "Rock/Loud.flac",
  "Old/Archive/Loud.mp3",
  "Live/Encore.wav",
]);

describe("matchTrack", () => {
  it("keeps a track that is where its path says, whatever the case", () => {
    expect(matchTrack("D:/Music", "d:\\music\\pop\\SUPER SONG.MP3", index)).toEqual({ kind: "kept" });
  });

  it("relinks by file name when the track moved within the library", () => {
    expect(matchTrack("D:/Music", "D:/Music/Inbox/Super Song.mp3", index)).toEqual({
      kind: "moved",
      to: "D:/Music/Pop/Super Song.mp3",
    });
  });

  it("relinks by file name when the library root moved", () => {
    expect(matchTrack("E:/Music", "D:/Music/Pop/Super Song.mp3", index, "D:/Music")).toEqual({
      kind: "moved",
      to: "E:/Music/Pop/Super Song.mp3",
    });
  });

  it("keeps a track when the root moved one folder up and the file didn't", () => {
    const up = buildIndex(["Library/Pop/Super Song.mp3"]);
    expect(matchTrack("D:/Music", "D:/Music/Library/Pop/Super Song.mp3", up, "D:/Music/Library")).toEqual({
      kind: "kept",
    });
  });

  it("treats a different name as a different track", () => {
    expect(matchTrack("D:/Music", "D:/Music/Pop/Super Song Version 2.mp3", index)).toEqual({
      kind: "notFound",
    });
  });

  it("breaks a tie by the old relative place, then extension, then folder", () => {
    // Same relative place under the old root wins outright.
    expect(matchTrack("E:/Music", "D:/Music/Old/Archive/Loud.mp3", index, "D:/Music")).toEqual({
      kind: "moved",
      to: "E:/Music/Old/Archive/Loud.mp3",
    });
    // No place to go on: the same extension, then the same parent folder.
    expect(matchTrack("D:/Music", "D:/Music/Inbox/Loud.flac", index)).toEqual({
      kind: "moved",
      to: "D:/Music/Rock/Loud.flac",
    });
    expect(matchTrack("D:/Music", "D:/Music/Stale/Archive/Loud.mp3", index)).toEqual({
      kind: "moved",
      to: "D:/Music/Old/Archive/Loud.mp3",
    });
  });

  it("reports a tie it can't break, with every candidate", () => {
    expect(matchTrack("D:/Music", "D:/Music/Inbox/Loud.mp3", index)).toEqual({
      kind: "ambiguous",
      candidates: ["D:/Music/Rock/Loud.mp3", "D:/Music/Old/Archive/Loud.mp3"],
    });
  });
});

describe("relinkTree", () => {
  const tree: CrateTree = [
    {
      id: "a",
      name: "A",
      tracks: ["D:/Music/Pop/Super Song.mp3", "D:/Music/Gone/Encore.wav", "D:/Music/Nope.mp3"],
      children: [
        { id: "b", name: "B", tracks: ["D:/Music/Gone/Encore.wav", "D:/Music/Inbox/Loud.mp3"], children: [] },
      ],
    },
    { id: "c", name: "C", tracks: ["D:/Music/Rock/Loud.mp3"], children: [] },
  ];
  const plan = relinkTree("D:/Music", tree, index);

  it("rewrites moved tracks everywhere they appear and counts each once", () => {
    expect(plan.tree[0].tracks).toEqual([
      "D:/Music/Pop/Super Song.mp3",
      "D:/Music/Live/Encore.wav",
      "D:/Music/Nope.mp3",
    ]);
    // "Rock/Loud.mp3" is held by crate C, so the stray "Loud.mp3" can only be the archived one.
    expect(plan.tree[0].children[0].tracks).toEqual([
      "D:/Music/Live/Encore.wav",
      "D:/Music/Old/Archive/Loud.mp3",
    ]);
    expect({ kept: plan.kept, moved: plan.moved, ambiguous: plan.ambiguous, notFound: plan.notFound }).toEqual({
      kept: 2,
      moved: 2,
      ambiguous: 0,
      notFound: 1,
    });
    expect(plan.moves.get("d:/music/gone/encore.wav")).toBe("D:/Music/Live/Encore.wav");
    expect(plan.moves.get("d:/music/inbox/loud.mp3")).toBe("D:/Music/Old/Archive/Loud.mp3");
    expect(plan.unresolved.get("d:/music/nope.mp3")).toEqual({ kind: "notFound" });
  });

  it("never relinks a missing track onto a file another member already holds", () => {
    const two = buildIndex(["Pop/Intro.mp3"]);
    const crates: CrateTree = [
      { id: "a", name: "A", tracks: ["D:/Music/Pop/Intro.mp3", "D:/Music/Rock/Intro.mp3"], children: [] },
    ];
    const result = relinkTree("D:/Music", crates, two);
    expect(result.tree).toBe(crates);
    expect(result.kept).toBe(1);
    expect(result.unresolved.get("d:/music/rock/intro.mp3")).toEqual({ kind: "notFound" });
    // Without a member in place, the file is free to be matched.
    expect(matchTrack("D:/Music", "D:/Music/Rock/Intro.mp3", two)).toEqual({
      kind: "moved",
      to: "D:/Music/Pop/Intro.mp3",
    });
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

describe("remapDurations", () => {
  it("carries lengths over to the new paths", () => {
    const moves = new Map([["d:/music/gone/encore.wav", "D:/Music/Live/Encore.wav"]]);
    expect(remapDurations({ "d:/music/gone/encore.wav": 42, "d:/music/x.mp3": 7 }, moves)).toEqual({
      "d:/music/live/encore.wav": 42,
      "d:/music/x.mp3": 7,
    });
    expect(movedPath("D:\\Music\\Gone\\Encore.wav", moves)).toBe("D:/Music/Live/Encore.wav");
    expect(movedPath("D:/Music/x.mp3", moves)).toBe("D:/Music/x.mp3");
  });
});
