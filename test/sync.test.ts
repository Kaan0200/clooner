import { describe, expect, it } from "vitest";
import {
  needsCopy,
  planSync,
  seratoCrateFile,
  volumeRelative,
  volumeRoot,
} from "../src/core/sync";
import type { CrateTree } from "../src/core/tree";

const crates: CrateTree = [
  {
    id: "club",
    name: "Club",
    tracks: ["C:/Music/Club/One.mp3", "D:/Elsewhere/Two.mp3"],
    children: [
      {
        id: "deep",
        name: "Deep/House",
        tracks: ["c:\\music\\club\\one.mp3", "C:/Music/House/Deep/Three.flac"],
        children: [],
      },
    ],
  },
  { id: "empty", name: "Empty", tracks: [], children: [] },
];

describe("planSync", () => {
  const plan = planSync("C:\\Music", "E:\\", crates);

  it("copies each track once even when it is in several crates", () => {
    expect(plan.tracks.map((t) => t.relative)).toEqual(["Club/One.mp3", "House/Deep/Three.flac"]);
    expect(plan.tracks[0].clonePath).toBe("E:/Tracks/Club/One.mp3");
    expect(plan.tracks[0].source).toBe("C:/Music/Club/One.mp3");
  });

  it("lists every crate with its path of names, and shares track jobs", () => {
    expect(plan.crates.map((c) => c.names)).toEqual([["Club"], ["Club", "Deep/House"], ["Empty"]]);
    expect(plan.crates[1].tracks[0]).toBe(plan.tracks[0]);
    expect(plan.crates[2].tracks).toEqual([]);
  });

  it("sets aside tracks outside the source library", () => {
    expect(plan.outside).toEqual(["D:/Elsewhere/Two.mp3"]);
    expect(plan.crates[0].outside).toEqual(["D:/Elsewhere/Two.mp3"]);
    expect(plan.crates[0].tracks).toHaveLength(1);
  });

  it("names a stub per track inside the crate's encoded folder", () => {
    expect(plan.crates[1].stubs.map((s) => s.file)).toEqual([
      "E:/Crates/Club/Deep／House/One.m3u",
      "E:/Crates/Club/Deep／House/Three.m3u",
    ]);
  });

  it("numbers stubs whose tracks share a file name", () => {
    const twins: CrateTree = [
      { id: "a", name: "A", children: [], tracks: ["C:/Music/x/Same.mp3", "C:/Music/y/Same.mp3"] },
    ];
    const files = planSync("C:/Music", "E:/", twins).crates[0].stubs.map((s) => s.file);
    expect(files).toEqual(["E:/Crates/A/Same.m3u", "E:/Crates/A/Same (2).m3u"]);
  });
});

describe("needsCopy", () => {
  const state = { size: 10, mtime: 1000 };

  it("copies when the clone lacks the file or nothing was recorded", () => {
    expect(needsCopy(state, state, false)).toBe(true);
    expect(needsCopy(undefined, state, true)).toBe(true);
  });

  it("copies only when the recorded source state differs", () => {
    expect(needsCopy(state, { size: 10, mtime: 1000 }, true)).toBe(false);
    expect(needsCopy(state, { size: 11, mtime: 1000 }, true)).toBe(true);
    expect(needsCopy(state, { size: 10, mtime: 2000 }, true)).toBe(true);
    expect(needsCopy({ size: 10, mtime: null }, { size: 10, mtime: null }, true)).toBe(false);
  });
});

describe("volume paths", () => {
  it("finds the volume root on Windows, macOS and elsewhere", () => {
    expect(volumeRoot("E:\\Clone\\Tracks")).toBe("E:");
    expect(volumeRoot("/Volumes/GIG USB/Tracks")).toBe("/Volumes/GIG USB");
    expect(volumeRoot("/home/dj/clone")).toBe("/");
  });

  it("makes paths relative to the volume the way Serato expects", () => {
    expect(volumeRelative("E:\\Tracks\\Club\\One.mp3")).toBe("Tracks/Club/One.mp3");
    expect(volumeRelative("E:/Clone/Tracks/One.mp3")).toBe("Clone/Tracks/One.mp3");
    expect(volumeRelative("/Volumes/GIG/Tracks/One.mp3")).toBe("Tracks/One.mp3");
    expect(volumeRelative("/home/dj/One.mp3")).toBe("home/dj/One.mp3");
  });

  it("names crate files with %% between levels", () => {
    expect(seratoCrateFile("E:/", ["Club", "Deep/House"])).toBe(
      "E:/_Serato_/Subcrates/Club%%Deep／House.crate",
    );
  });
});
