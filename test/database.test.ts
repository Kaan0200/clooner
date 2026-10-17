import { describe, expect, it } from "vitest";
import {
  addTracks,
  DATABASE_VERSION,
  decodeDatabase,
  encodeDatabase,
  newDatabase,
  newTrackRecord,
  seratoFileType,
  trackPaths,
} from "../src/core/database";
import { decodeFields, decodeUtf16be, encodeFields, nested, text, uint32 } from "../src/core/tlv";

const ADDED = Date.UTC(2026, 9, 15, 12, 0, 0);
const track = { path: "Clone/Tracks/House/One.mp3", size: 12_345_678, mtime: Date.UTC(2026, 5, 1) };

/** A database the way Serato would write it, with tags and a field we don't model. */
function seratoDatabase(): Uint8Array {
  return encodeFields([
    text("vrsn", DATABASE_VERSION),
    nested("otrk", [
      text("ttyp", "mp3"),
      text("pfil", "Music/Two.mp3"),
      text("tsng", "Two"),
      text("tart", "Someone"),
      uint32("uadd", 1_700_000_000),
      { tag: "bhrt", data: Uint8Array.of(1) },
    ]),
    { tag: "xxxx", data: Uint8Array.of(1, 2, 3) },
  ]);
}

describe("database codec", () => {
  it("starts empty with Serato's version string", () => {
    const db = decodeDatabase(encodeDatabase(newDatabase()));
    expect(db).toEqual({ version: DATABASE_VERSION, entries: [] });
  });

  it("round-trips a Serato-written database byte for byte", () => {
    const bytes = seratoDatabase();
    expect(encodeDatabase(decodeDatabase(bytes))).toEqual(bytes);
  });

  it("lists track paths and keeps other entries", () => {
    const db = decodeDatabase(seratoDatabase());
    expect(trackPaths(db)).toEqual(["Music/Two.mp3"]);
    expect(db.entries.map((e) => e.kind)).toEqual(["track", "other"]);
  });

  it("rejects a truncated file", () => {
    const bytes = seratoDatabase();
    expect(() => decodeDatabase(bytes.subarray(0, bytes.length - 2))).toThrow(/runs past the end/);
  });
});

describe("new track records", () => {
  it("carry the file's type, path, size and times in Serato's layout", () => {
    const record = newTrackRecord(track, ADDED);
    const tags = record.fields.map((f) => f.tag);
    expect(tags).toEqual([
      "ttyp", "pfil", "tadd", "uadd", "ulbl", "utme", "ufsb", "sbav",
      "bhrt", "bmis", "bply", "blop", "bitu", "bovc", "bcrt",
      "biro", "bwlb", "bwll", "buns", "bbgl", "bkrk", "bstm",
    ]);

    const field = (tag: string) => record.fields.find((f) => f.tag === tag)!.data;
    const u32 = (tag: string) => new DataView(field(tag).buffer, field(tag).byteOffset).getUint32(0);
    expect(decodeUtf16be(field("ttyp"))).toBe("mp3");
    expect(decodeUtf16be(field("pfil"))).toBe(track.path);
    expect(decodeUtf16be(field("tadd"))).toBe(String(ADDED / 1000));
    expect(u32("uadd")).toBe(ADDED / 1000);
    expect(u32("utme")).toBe(track.mtime / 1000);
    expect(u32("ufsb")).toBe(track.size);
    expect(u32("ulbl")).toBe(0xffffff);
    expect(field("sbav")).toEqual(Uint8Array.of(0, 0));
    for (const tag of tags.filter((t) => t.startsWith("b"))) expect(field(tag)).toEqual(Uint8Array.of(0));
  });

  it("use the added time as the modified time when the file has none", () => {
    const record = newTrackRecord({ ...track, mtime: null }, ADDED);
    const utme = record.fields.find((f) => f.tag === "utme")!.data;
    expect(new DataView(utme.buffer, utme.byteOffset).getUint32(0)).toBe(ADDED / 1000);
  });

  it("name file types the way Serato does", () => {
    expect(seratoFileType("a.MP3")).toBe("mp3");
    expect(seratoFileType("a.wav")).toBe("wave");
    expect(seratoFileType("a.aif")).toBe("aiff");
    expect(seratoFileType("a.aiff")).toBe("aiff");
    expect(seratoFileType("a.flac")).toBe("flac");
    expect(seratoFileType("a.m4a")).toBe("m4a");
    expect(seratoFileType("noext")).toBe("");
  });
});

describe("adding tracks", () => {
  it("appends tracks Serato doesn't have and leaves its records untouched", () => {
    const original = seratoDatabase();
    const { database, added } = addTracks(decodeDatabase(original), [track], ADDED);
    expect(added).toBe(1);
    expect(trackPaths(database)).toEqual(["Music/Two.mp3", track.path]);

    // Everything Serato wrote is still there, in place, byte for byte.
    const bytes = encodeDatabase(database);
    expect(bytes.subarray(0, original.length)).toEqual(original);
    expect(decodeFields(bytes).map((f) => f.tag)).toEqual(["vrsn", "otrk", "xxxx", "otrk"]);
  });

  it("skips tracks already there, ignoring case, and duplicates in the input", () => {
    const { database, added } = addTracks(
      decodeDatabase(seratoDatabase()),
      [{ ...track, path: "music/TWO.mp3" }, track, { ...track, path: track.path.toUpperCase() }],
      ADDED,
    );
    expect(added).toBe(1);
    expect(trackPaths(database)).toEqual(["Music/Two.mp3", track.path]);
  });

  it("doesn't change the database it was given", () => {
    const db = decodeDatabase(seratoDatabase());
    addTracks(db, [track], ADDED);
    expect(db.entries).toHaveLength(2);
  });
});
