import { describe, expect, it } from "vitest";
import { decodeName, decodePath, encodeName, encodePath } from "../src/core/names";

const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// Valid on exFAT, FAT and Windows.
function isPortable(name: string) {
  return !ILLEGAL.test(name) && !/[ .]$/.test(name) && !RESERVED.test(name);
}

describe("name encoding", () => {
  it.each([
    ["AC/DC", "AC／DC"],
    ['Intro: Part 1?.mp3', "Intro： Part 1？.mp3"],
    ['a\\b*c"d<e>f|g', 'a＼b＊c＂d＜e＞f｜g'],
    ["tab\there", "tab␉here"],
    ["Live ", "Live␠"],
    ["Vol. 2.", "Vol. 2．"],
    [".", "．"],
    ["..", ".．"],
    ["CON", "ＣON"],
    ["con.mp3", "ｃon.mp3"],
    ["COM1.flac", "ＣOM1.flac"],
    ["lpt9", "ｌpt9"],
    ["Plain name.mp3", "Plain name.mp3"],
  ])("encodes %j as %j", (name, encoded) => {
    expect(encodeName(name)).toBe(encoded);
    expect(isPortable(encodeName(name))).toBe(true);
    expect(decodeName(encoded)).toBe(name);
  });

  it("does not treat names that merely start with a reserved word as reserved", () => {
    expect(encodeName("CONTROL.mp3")).toBe("CONTROL.mp3");
    expect(encodeName("Nulla.mp3")).toBe("Nulla.mp3");
  });

  it.each([
    "Already／encoded？",
    "Full-width Ｃ Ｐ Ａ Ｎ Ｌ letters",
    "Escape ‛ char‛",
    "‛／",
    "Ends with look-alike ␠",
    "Mixed: ／ and /",
  ])("round-trips names that already contain look-alikes: %j", (name) => {
    expect(decodeName(encodeName(name))).toBe(name);
  });

  it("keeps decomposed and composed accents distinct and intact", () => {
    const composed = "Beyoncé - Déjà Vu.m4a";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(decodeName(encodeName(composed))).toBe(composed);
    expect(decodeName(encodeName(decomposed))).toBe(decomposed);
  });

  it("round-trips every character that needs encoding", () => {
    const name = Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)).join("") + '\\/:*?"<>|';
    expect(isPortable(encodeName(name))).toBe(true);
    expect(decodeName(encodeName(name))).toBe(name);
  });

  it("encodes each segment of a path", () => {
    const path = "Music/AC:DC/Live ./CON.mp3";
    const encoded = encodePath(path);
    expect(encoded).toBe("Music/AC：DC/Live ．/ＣON.mp3");
    expect(encoded.split("/").every(isPortable)).toBe(true);
    expect(decodePath(encoded)).toBe(path);
  });
});
