import { describe, expect, it } from "vitest";
import {
  absolutePath,
  baseName,
  folderOf,
  isAbsolutePath,
  relativePath,
  trackPath,
} from "../src/core/paths";

describe("track paths", () => {
  it("tells absolute paths from tree paths", () => {
    expect(isAbsolutePath("C:/Music/a.mp3")).toBe(true);
    expect(isAbsolutePath("c:\\Music\\a.mp3")).toBe(true);
    expect(isAbsolutePath("/Volumes/GIG/a.mp3")).toBe(true);
    expect(isAbsolutePath("Club/a.mp3")).toBe(false);
    expect(isAbsolutePath("a.mp3")).toBe(false);
  });

  it("makes a file relative to the root it is under", () => {
    expect(relativePath("C:\\Music", "c:/music/Club/a.mp3")).toBe("Club/a.mp3");
    expect(relativePath("C:/Music", "C:/Music")).toBeNull();
    expect(relativePath("C:/Music", "C:/MusicVideos/a.mp3")).toBeNull();
    expect(relativePath("C:/Music", "D:/a.mp3")).toBeNull();
  });

  it("records a dropped file relative to the library, or as it is when outside", () => {
    expect(trackPath("C:/Music", "C:\\Music\\Club\\a.mp3")).toBe("Club/a.mp3");
    expect(trackPath("C:/Music", "D:\\Other\\a.mp3")).toBe("D:/Other/a.mp3");
    expect(trackPath(null, "C:\\Music\\a.mp3")).toBe("C:/Music/a.mp3");
  });

  it("finds the file for a track", () => {
    expect(absolutePath("C:\\Music\\", "Club/a.mp3")).toBe("C:/Music/Club/a.mp3");
    expect(absolutePath("C:/Music", "D:\\Other\\a.mp3")).toBe("D:/Other/a.mp3");
  });

  it("splits folders and names", () => {
    expect(folderOf("Club/Deep/a.mp3")).toBe("Club/Deep");
    expect(folderOf("a.mp3")).toBe("");
    expect(folderOf("D:/Other/a.mp3")).toBe("D:/Other");
    expect(baseName("C:\\Music\\Club\\")).toBe("Club");
    expect(baseName("E:/")).toBe("E:");
    expect(baseName("a.mp3")).toBe("a.mp3");
  });
});
