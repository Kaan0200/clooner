import { describe, expect, it } from "vitest";
import { duplicateTracks, trackIssues } from "../src/core/issues";
import type { CrateTree } from "../src/core/tree";

const tree: CrateTree = [
  {
    id: "club",
    name: "Club",
    children: [{ id: "deep", name: "Deep", children: [], tracks: ["C:/Music/Deep/Song.flac", "C:/Music/a.mp3"] }],
    tracks: ["C:/Music/song.mp3", "C:/Music/b.mp3"],
  },
  // The same file again, spelled differently: not a duplicate of itself.
  { id: "home", name: "Home", children: [], tracks: ["c:\\music\\A.MP3", "D:/Other/song.mp3"] },
];

describe("duplicate tracks", () => {
  it("groups different files by title, ignoring case and extension", () => {
    const dupes = duplicateTracks(tree);
    expect([...dupes.keys()].sort()).toEqual([
      "c:/music/deep/song.flac",
      "c:/music/song.mp3",
      "d:/other/song.mp3",
    ]);
    expect(dupes.get("c:/music/song.mp3")).toEqual(["C:/Music/Deep/Song.flac", "D:/Other/song.mp3"]);
  });

  it("does not count the same file in two crates", () => {
    expect(duplicateTracks(tree).has("c:/music/a.mp3")).toBe(false);
  });
});

describe("track issues", () => {
  it("lists sync conflicts before duplicates", () => {
    const issues = trackIssues(tree, [
      { path: "E:/", conflicts: [{ path: "C:\\Music\\song.mp3", kept: "clone", when: "2026-10-13T00:00:00Z" }] },
      { path: "F:/", conflicts: [{ path: "C:/Music/b.mp3", kept: "source", when: "2026-10-13T00:00:00Z" }] },
    ]);
    expect(issues.get("c:/music/song.mp3")?.map((i) => i.kind)).toEqual(["sync", "duplicate"]);
    expect(issues.get("c:/music/song.mp3")?.[0].detail).toContain("E:/");
    expect(issues.get("c:/music/song.mp3")?.[0].detail).toContain("the clone's");
    expect(issues.get("c:/music/b.mp3")?.map((i) => i.kind)).toEqual(["sync"]);
    expect(issues.get("c:/music/b.mp3")?.[0].detail).toContain("the library's");
    expect(issues.has("c:/music/a.mp3")).toBe(false);
  });

  it("names the other files in a duplicate's detail", () => {
    const issues = trackIssues(tree, []);
    expect(issues.get("d:/other/song.mp3")?.[0].detail).toContain("C:/Music/song.mp3");
    expect(issues.get("d:/other/song.mp3")?.[0].detail).toContain("C:/Music/Deep/Song.flac");
  });
});
