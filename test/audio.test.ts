import { describe, expect, it } from "vitest";
import { isAudioFile } from "../src/core/audio";

describe("isAudioFile", () => {
  it("accepts common DJ formats regardless of case", () => {
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("Track.FLAC")).toBe(true);
    expect(isAudioFile("live set.aiff")).toBe(true);
  });

  it("rejects non-audio and extensionless names", () => {
    expect(isAudioFile("cover.jpg")).toBe(false);
    expect(isAudioFile("playlist.m3u")).toBe(false);
    expect(isAudioFile("README")).toBe(false);
    expect(isAudioFile(".mp3")).toBe(true); // dotfile with audio ext still counts
  });
});
