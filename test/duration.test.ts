import { describe, expect, it } from "vitest";
import { durationKey, formatDuration, sumDurations } from "../src/core/duration";

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59.6, "1:00"],
    [2912, "48:32"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [-4, "0:00"],
  ])("formats %d seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("sumDurations", () => {
  const known = { "c:/music/a.mp3": 200, "c:/music/b.mp3": 100.4 };

  it("adds known lengths and counts the rest, ignoring case and separators", () => {
    expect(sumDurations(["C:\\Music\\A.mp3", "C:/Music/b.mp3", "C:/Music/c.mp3"], known)).toEqual({
      seconds: 300.4,
      unknown: 1,
    });
  });

  it("is zero for no tracks", () => {
    expect(sumDurations([], known)).toEqual({ seconds: 0, unknown: 0 });
  });

  it("keys paths the same way they are stored", () => {
    expect(durationKey("C:\\Music\\A.mp3")).toBe("c:/music/a.mp3");
  });
});
