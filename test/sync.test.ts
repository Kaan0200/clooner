import { describe, expect, it } from "vitest";
import {
  decidePull,
  decidePush,
  needsCopy,
  planCrates,
  planTracks,
  sameFile,
  seratoCrateFile,
  seratoDatabaseFile,
  seratoSubcratesFolder,
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
        tracks: ["C:/Music/Club/One.mp3", "C:/Music/House/Deep/Three.flac"],
        children: [],
      },
    ],
  },
  { id: "empty", name: "Empty", tracks: [], children: [] },
];

describe("planTracks", () => {
  it("maps tracks into the clone once each, keeping the first spelling", () => {
    const plan = planTracks("C:\\Music", "E:\\", [
      "C:/Music/Club/One.mp3",
      "c:\\music\\club\\one.mp3",
      "C:/Music/House/Deep/Three.flac",
    ]);
    expect(plan.tracks).toEqual([
      { source: "C:/Music/Club/One.mp3", relative: "Club/One.mp3", clonePath: "E:/Tracks/Club/One.mp3" },
      {
        source: "C:/Music/House/Deep/Three.flac",
        relative: "House/Deep/Three.flac",
        clonePath: "E:/Tracks/House/Deep/Three.flac",
      },
    ]);
    expect(plan.outside).toEqual([]);
  });

  it("sets aside tracks outside the source library", () => {
    const plan = planTracks("C:/Music", "E:/", ["D:/Elsewhere/Two.mp3", "C:/Music/x.mp3"]);
    expect(plan.outside).toEqual(["D:/Elsewhere/Two.mp3"]);
    expect(plan.tracks.map((t) => t.relative)).toEqual(["x.mp3"]);
  });

  it("takes tree paths, which are relative to the source root", () => {
    const plan = planTracks("C:\\Music", "E:\\", ["Club/One.mp3", "club\\one.mp3", "Mix: 1/Two.mp3"]);
    expect(plan.tracks).toEqual([
      { source: "C:/Music/Club/One.mp3", relative: "Club/One.mp3", clonePath: "E:/Tracks/Club/One.mp3" },
      { source: "C:/Music/Mix: 1/Two.mp3", relative: "Mix: 1/Two.mp3", clonePath: "E:/Tracks/Mix： 1/Two.mp3" },
    ]);
    expect(plan.outside).toEqual([]);
  });
});

describe("planCrates", () => {
  const jobs = planCrates("C:\\Music", "E:\\", crates);

  it("lists every crate with its path of names", () => {
    expect(jobs.map((c) => c.names)).toEqual([["Club"], ["Club", "Deep/House"], ["Empty"]]);
  });

  it("gives each crate its member tracks' places in the clone", () => {
    expect(jobs[0].tracks.map((t) => t.clonePath)).toEqual(["E:/Tracks/Club/One.mp3"]);
    expect(jobs[0].outside).toEqual(["D:/Elsewhere/Two.mp3"]);
    expect(jobs[1].tracks.map((t) => t.clonePath)).toEqual([
      "E:/Tracks/Club/One.mp3",
      "E:/Tracks/House/Deep/Three.flac",
    ]);
    expect(jobs[2].tracks).toEqual([]);
  });
});

const state = { size: 10, mtime: 100_000 };
const record = { source: state, clone: state };

describe("needsCopy", () => {
  it("copies when the clone lacks the file or nothing was recorded", () => {
    expect(needsCopy(record, state, false)).toBe(true);
    expect(needsCopy(undefined, state, true)).toBe(true);
  });

  it("copies only when the recorded source state differs", () => {
    expect(needsCopy(record, { size: 10, mtime: 100_000 }, true)).toBe(false);
    expect(needsCopy(record, { size: 11, mtime: 100_000 }, true)).toBe(true);
    expect(needsCopy(record, { size: 10, mtime: 200_000 }, true)).toBe(true);
    const noTime = { size: 10, mtime: null };
    expect(needsCopy({ source: noTime, clone: noTime }, noTime, true)).toBe(false);
  });
});

describe("sameFile", () => {
  it("tolerates the two-second timestamps of FAT drives", () => {
    expect(sameFile(state, { size: 10, mtime: 101_999 })).toBe(true);
    expect(sameFile(state, { size: 10, mtime: 102_001 })).toBe(false);
    expect(sameFile(state, { size: 9, mtime: 100_000 })).toBe(false);
    expect(sameFile(state, { size: 10, mtime: null })).toBe(false);
  });
});

describe("decidePush", () => {
  const later = { size: 12, mtime: 500_000 };
  const other = { size: 13, mtime: 300_000 };

  it("copies what the clone lacks and never copies back", () => {
    expect(decidePush(record, state, null)).toBe("copy");
    expect(decidePush(record, null, state)).toBe("onlyClone");
    expect(decidePush(undefined, null, null)).toBe("missing");
  });

  it("with a record, copies only when the source alone changed", () => {
    expect(decidePush(record, state, state)).toBe("unchanged");
    expect(decidePush(record, later, state)).toBe("copy");
    expect(decidePush(record, state, later)).toBe("cloneChanged");
    expect(decidePush(record, other, later)).toBe("bothChanged");
    expect(decidePush(record, later, other)).toBe("bothChanged");
  });

  it("without a record, takes the newer file to be the changed one", () => {
    expect(decidePush(undefined, state, { ...state })).toBe("unchanged");
    expect(decidePush(undefined, later, state)).toBe("copy");
    expect(decidePush(undefined, state, later)).toBe("cloneChanged");
  });

  it("lets the source win ties and unknown timestamps", () => {
    expect(decidePush(undefined, { size: 1, mtime: 100_000 }, { size: 2, mtime: 101_000 })).toBe("copy");
    expect(decidePush(undefined, { size: 1, mtime: null }, { size: 2, mtime: 9 })).toBe("copy");
  });
});

describe("decidePull", () => {
  const later = { size: 12, mtime: 500_000 };
  const other = { size: 13, mtime: 300_000 };

  it("brings in what the source lacks and nothing the clone lacks", () => {
    expect(decidePull(record, null, state)).toBe("copy");
    expect(decidePull(record, state, null)).toBe("unchanged");
    expect(decidePull(undefined, null, null)).toBe("missing");
  });

  it("with a record, copies only when the clone alone changed", () => {
    expect(decidePull(record, state, state)).toBe("unchanged");
    expect(decidePull(record, state, later)).toBe("copy");
    expect(decidePull(record, later, state)).toBe("unchanged");
    expect(decidePull(record, other, later)).toBe("bothChanged");
  });

  it("without a record, brings in only a clearly newer clone file", () => {
    expect(decidePull(undefined, state, { ...state })).toBe("unchanged");
    expect(decidePull(undefined, state, later)).toBe("copy");
    expect(decidePull(undefined, later, state)).toBe("unchanged");
    expect(decidePull(undefined, { size: 1, mtime: 100_000 }, { size: 2, mtime: 101_000 })).toBe("unchanged");
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

  it("puts the Serato folder at the root of the drive, not inside the clone", () => {
    expect(seratoSubcratesFolder("E:\\CLONE")).toBe("E:/_Serato_/Subcrates");
    expect(seratoDatabaseFile("E:\\CLONE")).toBe("E:/_Serato_/database V2");
    expect(seratoSubcratesFolder("/Volumes/GIG USB/Clone")).toBe("/Volumes/GIG USB/_Serato_/Subcrates");
    expect(seratoSubcratesFolder("/home/dj/clone")).toBe("/_Serato_/Subcrates");
    expect(seratoCrateFile("E:/Clone", ["Club"])).toBe("E:/_Serato_/Subcrates/Club.crate");
  });

  it("names crate files with %% between levels", () => {
    expect(seratoCrateFile("E:/", ["Club", "Deep/House"])).toBe(
      "E:/_Serato_/Subcrates/Club%%Deep／House.crate",
    );
  });
});
