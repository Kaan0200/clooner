import { describe, expect, it } from "vitest";
import { duplicateTracks, issuesFor, trackIssues } from "../src/core/issues";
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
    expect(dupes.get("c:/music/song.mp3")?.sort()).toEqual(["C:/Music/Deep/Song.flac", "D:/Other/song.mp3"]);
  });

  it("does not count the same file in two crates", () => {
    expect(duplicateTracks(tree).has("c:/music/a.mp3")).toBe(false);
  });

  it("flags a title wholly contained in another, on word boundaries", () => {
    const crates: CrateTree = [
      {
        id: "x",
        name: "X",
        children: [],
        tracks: [
          "C:/Music/Super Song.mp3",
          "C:/Music/Super Song Version 2.mp3",
          "C:/Music/Super Song Version 1.mp3",
          "C:/Music/Super Songs.mp3",
          "C:/Music/The Super Song (Remix).mp3",
          "C:/Music/Song.mp3",
          "C:/Music/Songbird.mp3",
        ],
      },
    ];
    const dupes = duplicateTracks(crates);
    expect(dupes.get("c:/music/super song.mp3")?.sort()).toEqual([
      "C:/Music/Song.mp3",
      "C:/Music/Super Song Version 1.mp3",
      "C:/Music/Super Song Version 2.mp3",
      "C:/Music/The Super Song (Remix).mp3",
    ]);
    // Version 1 and Version 2 contain "Super Song" (and "Song") but not each other.
    expect(dupes.get("c:/music/super song version 1.mp3")?.sort()).toEqual(["C:/Music/Song.mp3", "C:/Music/Super Song.mp3"]);
    expect(dupes.get("c:/music/super song version 2.mp3")?.sort()).toEqual(["C:/Music/Song.mp3", "C:/Music/Super Song.mp3"]);
    // "Songs" and "Songbird" are different words.
    expect(dupes.has("c:/music/super songs.mp3")).toBe(false);
    expect(dupes.has("c:/music/songbird.mp3")).toBe(false);
    // "Song" is one whole word inside every longer title.
    expect(dupes.get("c:/music/song.mp3")?.sort()).toEqual([
      "C:/Music/Super Song Version 1.mp3",
      "C:/Music/Super Song Version 2.mp3",
      "C:/Music/Super Song.mp3",
      "C:/Music/The Super Song (Remix).mp3",
    ]);
  });
});

describe("track issues", () => {
  it("lists sync conflicts before duplicates", () => {
    const issues = trackIssues(tree, [
      { path: "E:/", conflicts: [{ path: "C:\\Music\\song.mp3", kept: "clone", when: "2026-10-13T00:00:00Z" }] },
      { path: "F:/", conflicts: [{ path: "C:/Music/b.mp3", kept: "source", when: "2026-10-13T00:00:00Z" }] },
    ]).byTrack;
    expect(issues.get("c:/music/song.mp3")?.map((i) => i.kind)).toEqual(["sync", "duplicate"]);
    expect(issues.get("c:/music/song.mp3")?.[0].detail).toContain("E:/");
    expect(issues.get("c:/music/song.mp3")?.[0].detail).toContain("the clone's");
    expect(issues.get("c:/music/b.mp3")?.map((i) => i.kind)).toEqual(["sync"]);
    expect(issues.get("c:/music/b.mp3")?.[0].detail).toContain("the library's");
    expect(issues.has("c:/music/a.mp3")).toBe(false);
  });

  it("names the other files in a duplicate's detail", () => {
    const issues = trackIssues(tree, []).byTrack;
    expect(issues.get("d:/other/song.mp3")?.[0].detail).toContain("C:/Music/song.mp3");
    expect(issues.get("d:/other/song.mp3")?.[0].detail).toContain("C:/Music/Deep/Song.flac");
  });

  it("flags tracks the scan couldn't place, after sync conflicts", () => {
    const unresolved = new Map([
      ["c:/music/b.mp3", { kind: "notFound" as const }],
      ["c:/music/a.mp3", { kind: "ambiguous" as const, candidates: ["C:/Music/x/a.mp3", "C:/Music/y/a.mp3"] }],
    ]);
    const issues = trackIssues(
      tree,
      [{ path: "E:/", conflicts: [{ path: "C:/Music/b.mp3", kept: "source", when: "2026-10-13T00:00:00Z" }] }],
      unresolved,
    ).byTrack;
    expect(issues.get("c:/music/b.mp3")?.map((i) => i.kind)).toEqual(["sync", "notFound"]);
    expect(issues.get("c:/music/b.mp3")?.[1].detail).toContain("C:/Music/b.mp3");
    // Listed in two crates, flagged once.
    expect(issues.get("c:/music/a.mp3")?.map((i) => i.kind)).toEqual(["notFound"]);
    expect(issues.get("c:/music/a.mp3")?.[0].detail).toContain("C:/Music/y/a.mp3");
  });
});

describe("shared tracks", () => {
  const crates: CrateTree = [
    {
      id: "weddings",
      name: "Weddings",
      tracks: ["C:/Music/First.mp3", "C:/Music/Both.mp3"],
      children: [
        { id: "first", name: "First Dance", tracks: ["C:/Music/First.mp3", "C:/Music/Both.mp3"], children: [] },
        { id: "last", name: "Last Dance", tracks: ["C:/Music/Both.mp3"], children: [] },
      ],
    },
    { id: "club", name: "Club", tracks: ["C:/Music/First.mp3"], children: [] },
  ];
  const index = trackIssues(crates, []);

  it("is just scoping when the crates are one inside the other", () => {
    expect(issuesFor(index, "weddings", "C:/Music/First.mp3").map((i) => i.kind)).toEqual(["shared"]);
    expect(issuesFor(index, "weddings", "C:/Music/First.mp3")[0].detail).toContain("Club");
    expect(issuesFor(index, "weddings", "C:/Music/First.mp3")[0].detail).not.toContain("First Dance");
    // In "First Dance", the parent is scoping, "Club" is not.
    expect(issuesFor(index, "first", "C:/Music/First.mp3")[0].detail).toBe("Also in another crate:\nClub");
    // "Club" sees both of the others.
    expect(issuesFor(index, "club", "C:/Music/First.mp3")[0].detail).toContain("Weddings / First Dance");
  });

  it("flags siblings", () => {
    expect(issuesFor(index, "first", "C:/Music/Both.mp3")[0].detail).toBe(
      "Also in another crate:\nWeddings / Last Dance",
    );
    expect(issuesFor(index, "weddings", "C:/Music/Both.mp3")).toEqual([]);
  });

  it("adds the shared issue after the track's own", () => {
    const withDupes = trackIssues(
      [...crates, { id: "x", name: "X", tracks: ["C:/Music/Other/First.mp3"], children: [] }],
      [],
    );
    expect(issuesFor(withDupes, "club", "C:/Music/First.mp3").map((i) => i.kind)).toEqual(["duplicate", "shared"]);
  });
});
