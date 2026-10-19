import { describe, expect, it } from "vitest";
import {
  MANIFEST_VERSION,
  manifestPath,
  newSourceManifest,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "../src/core/manifest";

const full: Manifest = {
  version: MANIFEST_VERSION,
  kind: "source",
  libraryId: "lib-1",
  locationId: "loc-1",
  name: "Home library",
  created: "2026-10-19T00:00:00.000Z",
  revision: 7,
  crates: [
    {
      id: "club",
      name: "Club",
      children: [{ id: "deep", name: "Deep", children: [], tracks: ["Club/Deep/a.mp3"] }],
      tracks: ["Club/b.mp3"],
    },
  ],
  tracks: { "club/deep/a.mp3": { duration: 212.5 }, "club/b.mp3": {} },
  peers: {
    "loc-2": { name: "Gig stick", kind: "clone", revision: 6, lastSync: "2026-10-18T00:00:00.000Z", path: "E:/" },
  },
  synced: {},
};

describe("manifest", () => {
  it("round-trips through text", () => {
    expect(parseManifest(serializeManifest(full))).toEqual(full);
  });

  it("names the file at the root with forward slashes", () => {
    expect(manifestPath("E:\\Clone\\")).toBe("E:/Clone/clooner.json");
    expect(manifestPath("/Volumes/GIG")).toBe("/Volumes/GIG/clooner.json");
  });

  it("mints ids and starts a fresh source at revision 1", () => {
    const m = newSourceManifest("Music");
    expect(m.kind).toBe("source");
    expect(m.name).toBe("Music");
    expect(m.revision).toBe(1);
    expect(m.libraryId).toMatch(/[0-9a-f-]{36}/);
    expect(m.locationId).toMatch(/[0-9a-f-]{36}/);
    expect(m.libraryId).not.toBe(m.locationId);
    expect(m.crates).toEqual([]);
  });

  it("upgrades a version 1 clone marker", () => {
    const marker = {
      version: 1,
      kind: "clone",
      id: "old-clone",
      created: "2026-10-01T00:00:00.000Z",
      source: { path: "C:/Music" },
      lastSync: "2026-10-02T00:00:00.000Z",
      synced: {
        "Club/a.mp3": { size: 10, mtime: 1000 },
        "Club/b.mp3": { source: { size: 1, mtime: null }, clone: { size: 1, mtime: 5 } },
        "Club/c.mp3": "garbage",
      },
    };
    const m = parseManifest(JSON.stringify(marker));
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.kind).toBe("clone");
    expect(m.locationId).toBe("old-clone");
    expect(m.libraryId).toBeNull();
    expect(m.created).toBe(marker.created);
    expect(m.revision).toBe(0);
    expect(m.crates).toEqual([]);
    expect(m.peers).toEqual({});
    expect(m.synced).toEqual({
      "Club/a.mp3": { source: { size: 10, mtime: 1000 }, clone: { size: 10, mtime: 1000 } },
      "Club/b.mp3": { source: { size: 1, mtime: null }, clone: { size: 1, mtime: 5 } },
    });
  });

  it("rejects text that is not a clooner manifest", () => {
    expect(() => parseManifest("nope")).toThrow(/valid JSON/);
    expect(() => parseManifest("[1]")).toThrow(/JSON object/);
    expect(() => parseManifest(JSON.stringify({ hello: "world" }))).toThrow(/isn't a clooner location/);
    expect(() => parseManifest(JSON.stringify({ kind: "clone" }))).toThrow(/no location id/);
    expect(() => parseManifest(JSON.stringify({ kind: "source", locationId: "x", version: 99 }))).toThrow(
      /newer/,
    );
  });

  it("fills in anything missing or malformed", () => {
    const m = parseManifest(
      JSON.stringify({
        kind: "source",
        locationId: "x",
        revision: -3,
        crates: "no",
        tracks: { a: { duration: -1 }, b: { duration: 3 }, c: 5 },
        peers: { p: { kind: "clone", revision: "x" }, "": { name: "empty id" }, q: 7 },
        synced: { k: { size: "no" } },
      }),
    );
    expect(m.name).toBe("");
    expect(m.revision).toBe(0);
    expect(m.crates).toEqual([]);
    expect(m.tracks).toEqual({ a: {}, b: { duration: 3 } });
    expect(m.peers).toEqual({ p: { name: "", kind: "clone", revision: 0, lastSync: null, path: null } });
    expect(m.synced).toEqual({});
  });
});
