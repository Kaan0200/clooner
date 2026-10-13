import { describe, expect, it } from "vitest";
import { DB_VERSION, emptyDb, parseDb, serializeDb, type AppDb } from "../src/core/db";

const full: AppDb = {
  version: DB_VERSION,
  source: { path: "C:/Music", added: "2026-10-13T00:00:00.000Z" },
  clones: [
    { path: "E:/", id: "abc", added: "2026-10-13T01:00:00.000Z", lastSync: "2026-10-13T02:00:00.000Z" },
  ],
  crates: [
    {
      id: "club",
      name: "Club",
      children: [{ id: "deep", name: "Deep", children: [], tracks: ["C:/Music/a.mp3"] }],
      tracks: [],
    },
  ],
};

describe("app database", () => {
  it("round-trips through text", () => {
    expect(parseDb(serializeDb(full))).toEqual(full);
    expect(parseDb(serializeDb(emptyDb()))).toEqual(emptyDb());
  });

  it("ends the file with a newline and pretty-prints it", () => {
    const text = serializeDb(emptyDb());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "version": 1');
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
    const db = parseDb(JSON.stringify({ source: { path: "" }, clones: "nope", crates: 5 }));
    expect(db).toEqual(emptyDb());
  });

  it("drops bad clone entries and defaults their fields", () => {
    const db = parseDb(JSON.stringify({ clones: [{ path: "E:/" }, { id: "x" }, 7] }));
    expect(db.clones).toEqual([
      { path: "E:/", id: null, added: new Date(0).toISOString(), lastSync: null },
    ]);
  });

  it("repairs crates with missing ids or tracks and drops duplicates", () => {
    const db = parseDb(
      JSON.stringify({
        crates: [
          { name: "No id", children: [{ id: "k", name: "Kid" }] },
          { id: "k", name: "Duplicate" },
          { id: "t", name: "Tracks", tracks: ["a.mp3", 3, null] },
          { id: "bad" },
        ],
      }),
    );
    expect(db.crates.map((c) => c.name)).toEqual(["No id", "Tracks"]);
    expect(db.crates[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(db.crates[0].children).toEqual([{ id: "k", name: "Kid", children: [], tracks: [] }]);
    expect(db.crates[1].tracks).toEqual(["a.mp3"]);
  });
});
