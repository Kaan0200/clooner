import { describe, expect, it } from "vitest";
import {
  addCrate,
  addTracks,
  ancestorsOf,
  crateNameError,
  findCrate,
  hasContents,
  isWithin,
  moveCrate,
  moveTrack,
  removeCrate,
  removeTrack,
  renameCrate,
  rowCrateId,
  rowKey,
  siblingsOf,
  uniqueName,
  visibleRows,
  type CrateTree,
  type TreeRow,
} from "../src/core/tree";

const sample: CrateTree = [
  {
    id: "club",
    name: "Club",
    tracks: [],
    children: [
      { id: "club-2024", name: "2024", children: [], tracks: [] },
      {
        id: "club-house",
        name: "House",
        children: [{ id: "deep", name: "Deep", children: [], tracks: [] }],
        tracks: ["C:/Music/House/one.mp3"],
      },
    ],
  },
  { id: "weddings", name: "Weddings", children: [], tracks: [] },
];


describe("uniqueName", () => {
  it("uses the base name when it is free", () => {
    expect(uniqueName([])).toBe("New Crate");
  });

  it("numbers from 2 and ignores case", () => {
    const siblings = [
      { id: "a", name: "new crate", children: [], tracks: [] },
      { id: "b", name: "New Crate 2", children: [], tracks: [] },
    ];
    expect(uniqueName(siblings)).toBe("New Crate 3");
  });
});

describe("crateNameError", () => {
  it("accepts a plain unique name", () => {
    expect(crateNameError("Techno", sample)).toBeNull();
  });

  it.each([
    ["", /needs a name/],
    ["   ", /needs a name/],
    [" Club", /space/],
    ["Club ", /space/],
    ["A%%B", /%%/],
    ["tab\there", /control/],
    ["weddings", /already a crate/],
  ])("rejects %j", (name, message) => {
    expect(crateNameError(name, sample)).toMatch(message);
  });

  it("lets a crate keep its own name when renaming", () => {
    expect(crateNameError("Weddings", sample, "weddings")).toBeNull();
    expect(crateNameError("Club", sample, "weddings")).toMatch(/already a crate/);
  });
});

describe("addCrate", () => {
  it("adds a collection with a default name and does not mutate the input", () => {
    const before = JSON.stringify(sample);
    const { tree, node } = addCrate(sample, null);
    expect(node.name).toBe("New Crate");
    expect(node.children).toEqual([]);
    expect(tree).toHaveLength(3);
    expect(tree[2]).toBe(node);
    expect(JSON.stringify(sample)).toBe(before);
  });

  it("adds a subcrate under a nested parent with a given id", () => {
    const { tree, node } = addCrate(sample, "club-house", "Minimal", "min");
    expect(node).toEqual({ id: "min", name: "Minimal", children: [], tracks: [] });
    expect(findCrate(tree, "club-house")?.children.map((c) => c.name)).toEqual(["Deep", "Minimal"]);
    // Untouched branches are shared, not copied.
    expect(tree[1]).toBe(sample[1]);
    expect(tree[0].children[0]).toBe(sample[0].children[0]);
  });

  it("picks default names that are unique among the new siblings", () => {
    const first = addCrate(sample, "weddings");
    const second = addCrate(first.tree, "weddings");
    expect(second.node.name).toBe("New Crate 2");
    expect(addCrate(second.tree, null).node.name).toBe("New Crate");
  });

  it("rejects a missing parent and an invalid name", () => {
    expect(() => addCrate(sample, "nope")).toThrow(/not found/);
    expect(() => addCrate(sample, null, "club")).toThrow(/already a crate/);
  });
});

describe("renameCrate", () => {
  it("renames in place", () => {
    const tree = renameCrate(sample, "deep", "Deep House");
    expect(findCrate(tree, "deep")?.name).toBe("Deep House");
    expect(findCrate(sample, "deep")?.name).toBe("Deep");
  });

  it("rejects clashes with siblings but not with the crate itself", () => {
    expect(() => renameCrate(sample, "club-2024", "house")).toThrow(/already a crate/);
    expect(renameCrate(sample, "club-2024", "2024")).toEqual(sample);
    expect(() => renameCrate(sample, "nope", "X")).toThrow(/not found/);
  });
});

describe("addTracks", () => {
  it("appends new tracks with forward slashes and reports the count", () => {
    const { tree, added } = addTracks(sample, "deep", ["C:\\Music\\a.mp3", "D:/b.flac"]);
    expect(added).toBe(2);
    expect(findCrate(tree, "deep")?.tracks).toEqual(["C:/Music/a.mp3", "D:/b.flac"]);
    expect(findCrate(sample, "deep")?.tracks).toEqual([]);
  });

  it("skips tracks already in the crate, ignoring case and separators", () => {
    const { tree, added } = addTracks(sample, "club-house", [
      "c:\\music\\house\\ONE.mp3",
      "C:/Music/House/two.mp3",
      "C:/Music/House/two.mp3",
    ]);
    expect(added).toBe(1);
    expect(findCrate(tree, "club-house")?.tracks).toEqual([
      "C:/Music/House/one.mp3",
      "C:/Music/House/two.mp3",
    ]);
  });

  it("returns the same tree when nothing is new", () => {
    expect(addTracks(sample, "club-house", ["C:/Music/House/one.mp3"]).tree).toBe(sample);
    expect(() => addTracks(sample, "nope", ["x.mp3"])).toThrow(/not found/);
  });
});

describe("removeTrack and moveTrack", () => {
  it("removes a track regardless of case and separators, and ignores unknowns", () => {
    expect(findCrate(removeTrack(sample, "club-house", "c:\\music\\house\\ONE.mp3"), "club-house")?.tracks).toEqual([]);
    expect(removeTrack(sample, "club-house", "C:/Music/House/none.mp3")).toBe(sample);
    expect(removeTrack(sample, "nope", "x.mp3")).toBe(sample);
  });

  it("moves a track between crates", () => {
    const tree = moveTrack(sample, "club-house", "C:/Music/House/one.mp3", "deep");
    expect(findCrate(tree, "club-house")?.tracks).toEqual([]);
    expect(findCrate(tree, "deep")?.tracks).toEqual(["C:/Music/House/one.mp3"]);
  });

  it("can keep the track in the original crate", () => {
    const tree = moveTrack(sample, "club-house", "C:/Music/House/one.mp3", "weddings", true);
    expect(findCrate(tree, "club-house")?.tracks).toEqual(["C:/Music/House/one.mp3"]);
    expect(findCrate(tree, "weddings")?.tracks).toEqual(["C:/Music/House/one.mp3"]);
  });

  it("does nothing within the same crate and rejects missing crates", () => {
    expect(moveTrack(sample, "club-house", "C:/Music/House/one.mp3", "club-house")).toBe(sample);
    expect(() => moveTrack(sample, "nope", "x.mp3", "deep")).toThrow(/not found/);
    expect(() => moveTrack(sample, "club-house", "x.mp3", "nope")).toThrow(/not found/);
  });
});

describe("isWithin and moveCrate", () => {
  it("knows a crate's subtree", () => {
    expect(isWithin(sample, "club", "deep")).toBe(true);
    expect(isWithin(sample, "club", "club")).toBe(true);
    expect(isWithin(sample, "deep", "club")).toBe(false);
    expect(isWithin(sample, "weddings", "deep")).toBe(false);
  });

  it("moves a crate with its subtree under another crate", () => {
    const tree = moveCrate(sample, "club-house", "weddings");
    expect(findCrate(tree, "club")?.children.map((c) => c.id)).toEqual(["club-2024"]);
    expect(findCrate(tree, "weddings")?.children.map((c) => c.id)).toEqual(["club-house"]);
    expect(findCrate(tree, "deep")).toBeDefined();
  });

  it("moves a crate to the top level", () => {
    const tree = moveCrate(sample, "deep", null);
    expect(tree.map((c) => c.id)).toEqual(["club", "weddings", "deep"]);
    expect(findCrate(tree, "club-house")?.children).toEqual([]);
  });

  it("refuses to nest a crate inside itself or its subtree", () => {
    expect(() => moveCrate(sample, "club", "club")).toThrow(/inside itself/);
    expect(() => moveCrate(sample, "club", "deep")).toThrow(/inside itself/);
  });

  it("refuses a name clash and leaves a crate where it already is", () => {
    const clash = addCrate(sample, "weddings", "House").tree;
    expect(() => moveCrate(clash, "club-house", "weddings")).toThrow(/already a crate/);
    expect(moveCrate(sample, "deep", "club-house")).toBe(sample);
    expect(() => moveCrate(sample, "nope", null)).toThrow(/not found/);
  });
});

describe("removeCrate", () => {
  it("removes a nested crate and its subtree", () => {
    const tree = removeCrate(sample, "club-house");
    expect(findCrate(tree, "club-house")).toBeUndefined();
    expect(findCrate(tree, "deep")).toBeUndefined();
    expect(tree[0].children.map((c) => c.id)).toEqual(["club-2024"]);
  });

  it("removes a collection and ignores unknown ids", () => {
    expect(removeCrate(sample, "weddings").map((c) => c.id)).toEqual(["club"]);
    expect(removeCrate(sample, "nope")).toEqual(sample);
  });
});

describe("ancestorsOf and siblingsOf", () => {
  it("lists ancestors outermost first", () => {
    expect(ancestorsOf(sample, "deep")?.map((n) => n.id)).toEqual(["club", "club-house"]);
    expect(ancestorsOf(sample, "club")).toEqual([]);
    expect(ancestorsOf(sample, "nope")).toBeUndefined();
  });

  it("finds siblings at every level", () => {
    expect(siblingsOf(sample, null).map((n) => n.id)).toEqual(["club", "weddings"]);
    expect(siblingsOf(sample, "club").map((n) => n.id)).toEqual(["club", "weddings"]);
    expect(siblingsOf(sample, "club-2024").map((n) => n.id)).toEqual(["club-2024", "club-house"]);
    expect(siblingsOf(sample, "nope")).toEqual([]);
  });
});

describe("visibleRows", () => {
  const describeRow = (r: TreeRow) =>
    r.kind === "crate" ? `${r.depth}:${r.node.id}<${r.parentId}` : `${r.depth}:♪${r.path}@${r.crateId}`;

  it("shows only collections when nothing is expanded", () => {
    expect(visibleRows(sample, new Set()).map(describeRow)).toEqual(["0:club<null", "0:weddings<null"]);
  });

  it("walks into expanded crates, subcrates first then tracks, one level deeper", () => {
    const rows = visibleRows(sample, new Set(["club", "club-house"]));
    expect(rows.map(describeRow)).toEqual([
      "0:club<null",
      "1:club-2024<club",
      "1:club-house<club",
      "2:deep<club-house",
      "2:♪C:/Music/House/one.mp3@club-house",
      "0:weddings<null",
    ]);
  });

  it("hides everything under a collapsed crate even if deeper expansion is remembered", () => {
    const rows = visibleRows(sample, new Set(["club-house"]));
    expect(rows.map(describeRow)).toEqual(["0:club<null", "0:weddings<null"]);
  });

  it("keys rows uniquely and knows which crate each belongs to", () => {
    const rows = visibleRows(sample, new Set(["club", "club-house"]));
    expect(rowKey(rows[0])).toBe("club");
    expect(rowKey(rows[4])).toBe("club-house\u0000c:/music/house/one.mp3");
    expect(rowCrateId(rows[4])).toBe("club-house");
    expect(hasContents(sample[1])).toBe(false);
    expect(hasContents(sample[0].children[1])).toBe(true);
  });
});
