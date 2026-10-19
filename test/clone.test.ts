import { describe, expect, it } from "vitest";
import { cloneFolders, cloneTrackPath, isInside, leafFolders } from "../src/core/clone";

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

describe("cloneTrackPath", () => {
  it("places a track under Tracks/ from its tree path or its absolute path", () => {
    expect(cloneTrackPath("C:/Music", "E:\\", "Club/One.mp3")).toBe("E:/Tracks/Club/One.mp3");
    expect(cloneTrackPath("C:/Music", "E:/", "C:\\Music\\Club\\One.mp3")).toBe("E:/Tracks/Club/One.mp3");
  });

  it("has no place for a track outside the library", () => {
    expect(cloneTrackPath("C:/Music", "E:/", "D:/Other/One.mp3")).toBeNull();
    expect(cloneTrackPath("C:/Music", "E:/", "C:/Music")).toBeNull();
  });

  it("encodes names that are illegal on FAT drives", () => {
    expect(cloneTrackPath("C:/Music", "E:/", "Mix: Vol 1/What?.mp3")).toBe("E:/Tracks/Mix： Vol 1/What？.mp3");
  });
});
