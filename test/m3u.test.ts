import { describe, expect, it } from "vitest";
import { cloneCrateFolder, cloneTrackPath } from "../src/core/clone";
import { buildM3u, nativeSeparator, titleOf } from "../src/core/m3u";

describe("buildM3u", () => {
  it("writes the extended header, a title line per track, and native separators", () => {
    const text = buildM3u(
      [{ path: "E:/Tracks/Club/One.mp3" }, { path: "E:\\Tracks\\Two.flac", title: "Second" }],
      "\\",
    );
    expect(text).toBe(
      [
        "#EXTM3U",
        "#EXTINF:-1,One",
        "E:\\Tracks\\Club\\One.mp3",
        "#EXTINF:-1,Second",
        "E:\\Tracks\\Two.flac",
        "",
      ].join("\n"),
    );
  });

  it("is just the header for an empty crate", () => {
    expect(buildM3u([])).toBe("#EXTM3U\n");
  });
});

describe("titleOf", () => {
  it.each([
    ["C:/Music/Club/Track.mp3", "Track"],
    ["C:\\Music\\Mr. Fingers - Can You Feel It.flac", "Mr. Fingers - Can You Feel It"],
    ["/music/.hidden", ".hidden"],
    ["noext", "noext"],
  ])("titles %j as %j", (path, title) => {
    expect(titleOf(path)).toBe(title);
  });
});

describe("nativeSeparator", () => {
  it("uses backslashes for Windows drive and UNC paths, slashes otherwise", () => {
    expect(nativeSeparator("E:/Clone")).toBe("\\");
    expect(nativeSeparator("\\\\nas\\music")).toBe("\\");
    expect(nativeSeparator("/Volumes/GIG")).toBe("/");
  });
});

describe("cloneTrackPath", () => {
  it("maps a track under the source root into the clone's Tracks folder", () => {
    expect(cloneTrackPath("C:\\Music", "E:/", "C:/Music/Club/One.mp3")).toBe(
      "E:/Tracks/Club/One.mp3",
    );
    expect(cloneTrackPath("C:/Music/", "E:\\Clone\\", "c:\\music\\x.mp3")).toBe(
      "E:/Clone/Tracks/x.mp3",
    );
  });

  it("encodes names that are illegal on FAT drives", () => {
    expect(cloneTrackPath("C:/Music", "E:/", "C:/Music/Mix: Vol 1/a?.mp3")).toBe(
      "E:/Tracks/Mix： Vol 1/a？.mp3",
    );
  });

  it("returns null for tracks outside the source library", () => {
    expect(cloneTrackPath("C:/Music", "E:/", "D:/Other/x.mp3")).toBeNull();
    expect(cloneTrackPath("C:/Music", "E:/", "C:/MusicOld/x.mp3")).toBeNull();
    expect(cloneTrackPath("C:/Music", "E:/", "C:/Music")).toBeNull();
  });
});

describe("cloneCrateFolder", () => {
  it("nests one encoded folder per crate level under Crates", () => {
    expect(cloneCrateFolder("E:\\", ["Club", "House/Deep"])).toBe("E:/Crates/Club/House／Deep");
  });
});
