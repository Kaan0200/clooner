import { describe, expect, it } from "vitest";
import { DB_VERSION, emptyDb, parseDb, serializeDb, type AppDb } from "../src/core/db";
import { MANIFEST_VERSION } from "../src/core/manifest";

const full: AppDb = {
  version: DB_VERSION,
  source: { path: "C:/Music", added: "2026-10-13T00:00:00.000Z" },
  clones: [
    {
      path: "E:/",
      id: "abc",
      added: "2026-10-13T01:00:00.000Z",
      lastSync: "2026-10-13T02:00:00.000Z",
      conflicts: [{ path: "a.mp3", kept: "clone", when: "2026-10-13T02:00:00.000Z" }],
    },
  ],
  library: {
    version: MANIFEST_VERSION,
    kind: "source",
    libraryId: "lib",
    locationId: "loc",
    name: "Music",
    created: "2026-10-13T00:00:00.000Z",
    revision: 3,
    crates: [
      {
        id: "club",
        name: "Club",
        children: [{ id: "deep", name: "Deep", children: [], tracks: ["a.mp3"] }],
        tracks: [],
      },
    ],
    tracks: { "a.mp3": { duration: 212.5 } },
    peers: {},
    synced: {},
  },
  baseRevision: 3,
  dirty: false,
};

describe("app database", () => {
  it("round-trips through text", () => {
    expect(parseDb(serializeDb(full))).toEqual(full);
    expect(parseDb(serializeDb(emptyDb()))).toEqual(emptyDb());
  });

  it("ends the file with a newline and pretty-prints it", () => {
    const text = serializeDb(emptyDb());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "version": 2');
  });

  it("rejects text that is not a JSON object", () => {
    expect(() => parseDb("not json")).toThrow(/valid JSON/);
    expect(() => parseDb("[]")).toThrow(/JSON object/);
    expect(() => parseDb("null")).toThrow(/JSON object/);
  });

  it("rejects a database from a newer version", () => {
    expect(() => parseDb(JSON.stringify({ version: 99 }))).toThrow(/newer/);
  });

  it("fills in anything missing or malformed", () => {
    const db = parseDb(JSON.stringify({ version: 2, source: { path: "" }, clones: "nope", library: 5 }));
    expect(db).toEqual(emptyDb());
  });

  it("drops bad clone entries and defaults their fields", () => {
    const db = parseDb(JSON.stringify({ version: 2, clones: [{ path: "E:/" }, { id: "x" }, 7] }));
    expect(db.clones).toEqual([
      { path: "E:/", id: null, added: new Date(0).toISOString(), lastSync: null, conflicts: [] },
    ]);
  });

  it("keeps only usable conflicts and defaults their fields", () => {
    const db = parseDb(
      JSON.stringify({
        version: 2,
        clones: [{ path: "E:/", conflicts: [{ path: "a.mp3", kept: "bogus" }, { kept: "clone" }, "x"] }],
      }),
    );
    expect(db.clones[0].conflicts).toEqual([{ path: "a.mp3", kept: "source", when: new Date(0).toISOString() }]);
  });

  describe("upgrading a version 1 database", () => {
    const v1 = {
      version: 1,
      source: { path: "C:\\Music", added: "2026-10-13T00:00:00.000Z" },
      clones: [
        {
          path: "E:/",
          id: "abc",
          added: "2026-10-13T01:00:00.000Z",
          lastSync: null,
          conflicts: [{ path: "C:/Music/Club/a.mp3", kept: "clone", when: "2026-10-13T02:00:00.000Z" }],
        },
      ],
      crates: [
        {
          id: "club",
          name: "Club",
          children: [{ id: "deep", name: "Deep", children: [], tracks: ["C:/Music/Club/Deep/x.flac"] }],
          tracks: ["C:\\Music\\Club\\a.mp3", "D:/Elsewhere/b.mp3"],
        },
      ],
      durations: { "c:/music/club/a.mp3": 212.5, "d:/elsewhere/b.mp3": 10, bad: -1 },
    };
    const db = parseDb(JSON.stringify(v1));

    it("turns the crates and lengths into a source library to be written to the root", () => {
      expect(db.version).toBe(DB_VERSION);
      expect(db.source).toEqual({ path: "C:\\Music", added: "2026-10-13T00:00:00.000Z" });
      expect(db.dirty).toBe(true);
      expect(db.baseRevision).toBe(0);
      const lib = db.library!;
      expect(lib.kind).toBe("source");
      expect(lib.name).toBe("Music");
      expect(lib.revision).toBe(1);
      expect(lib.libraryId).toMatch(/[0-9a-f-]{36}/);
      expect(lib.tracks).toEqual({ "club/a.mp3": { duration: 212.5 }, "d:/elsewhere/b.mp3": { duration: 10 } });
    });

    it("makes track paths relative to the source, leaving outside tracks absolute", () => {
      const lib = db.library!;
      expect(lib.crates[0].tracks).toEqual(["Club/a.mp3", "D:/Elsewhere/b.mp3"]);
      expect(lib.crates[0].children[0].tracks).toEqual(["Club/Deep/x.flac"]);
      expect(db.clones[0].conflicts[0].path).toBe("Club/a.mp3");
    });

    it("keeps crates made before any source was chosen, as they are", () => {
      const noSource = parseDb(
        JSON.stringify({ version: 1, crates: [{ id: "a", name: "A", tracks: ["C:/x/a.mp3"] }] }),
      );
      expect(noSource.library?.crates[0].tracks).toEqual(["C:/x/a.mp3"]);
      expect(noSource.library?.name).toBe("");
      expect(noSource.source).toBeNull();
    });

    it("has no library when there was nothing to carry", () => {
      expect(parseDb(JSON.stringify({ version: 1 }))).toEqual(emptyDb());
    });
  });
});
