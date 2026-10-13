import { describe, expect, it } from "vitest";
import { cloneFolders, isInside, leafFolders } from "../src/core/clone";

describe("isInside", () => {
  it("detects nesting with mixed separators and case", () => {
    expect(isInside("C:\\Music", "c:/music/Club/2024")).toBe(true);
    expect(isInside("C:\\Music", "C:\\Music")).toBe(true);
    expect(isInside("C:\\Music", "C:\\MusicClone")).toBe(false);
    expect(isInside("E:\\", "C:\\Music")).toBe(false);
  });
});

describe("cloneFolders", () => {
  it("adds Tracks and Crates and mirrors source folders under Tracks", () => {
    expect(cloneFolders(["Club", "Club/2024"])).toEqual([
      "Tracks",
      "Crates",
      "Tracks/Club",
      "Tracks/Club/2024",
    ]);
  });

  it("encodes names that are illegal on FAT drives", () => {
    const [, , mirrored] = cloneFolders(["Mix: Vol 1"]);
    expect(mirrored).toBe("Tracks/Mix： Vol 1");
  });
});

describe("leafFolders", () => {
  it("keeps only folders with no children", () => {
    expect(leafFolders(["A", "A/B", "A/B/C", "A/D", "E"])).toEqual(["A/B/C", "A/D", "E"]);
  });

  it("does not treat a sibling with a shared prefix as a child", () => {
    expect(leafFolders(["Club", "Club 2024"])).toEqual(["Club", "Club 2024"]);
  });
});
