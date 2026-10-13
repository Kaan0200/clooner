import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeCrate, encodeCrate, newCrate } from "../src/core/crate";

const golden = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/golden/${name}`, import.meta.url)));
const cases: Record<string, string[]> = JSON.parse(
  readFileSync(new URL("./fixtures/golden/cases.json", import.meta.url), "utf8"),
);

describe("crate codec", () => {
  describe.each(Object.entries(cases))("golden case %s (written by cratedigger)", (name, tracks) => {
    it("encodes byte for byte", () => {
      expect(encodeCrate(newCrate(tracks))).toEqual(golden(`${name}.crate`));
    });

    it("decodes to the same crate", () => {
      expect(decodeCrate(golden(`${name}.crate`))).toEqual(newCrate(tracks));
    });
  });

  it("uses UTF-16 code units for lengths of characters outside the BMP", () => {
    const track = "Music/🎵 Emoji/🔥.mp3";
    const bytes = encodeCrate(newCrate([track]));
    const view = new DataView(bytes.buffer);

    // The otrk field is last: otrk <len> ptrk <len> <path>
    const pathBytes = track.length * 2;
    const otrk = bytes.length - (16 + pathBytes);
    expect(String.fromCharCode(...bytes.subarray(otrk, otrk + 4))).toBe("otrk");
    expect(view.getUint32(otrk + 4)).toBe(pathBytes + 8);
    expect(view.getUint32(otrk + 12)).toBe(pathBytes);
    expect(decodeCrate(bytes).tracks).toEqual([track]);
  });

  it("round-trips a non-default sort and columns", () => {
    const crate = {
      ...newCrate(["a.mp3"]),
      sort: { column: "bpm", reverse: true },
      columns: [{ name: "bpm", width: "120" }],
    };
    expect(decodeCrate(encodeCrate(crate))).toEqual(crate);
  });

  it("skips unknown fields", () => {
    const unknown = Uint8Array.of(0x78, 0x78, 0x78, 0x78, 0, 0, 0, 2, 0xab, 0xcd); // "xxxx", 2 bytes
    const known = encodeCrate(newCrate(["a.mp3"]));
    const bytes = new Uint8Array([...unknown, ...known]);
    expect(decodeCrate(bytes)).toEqual(newCrate(["a.mp3"]));
  });

  it("rejects a truncated file", () => {
    const bytes = encodeCrate(newCrate(["a.mp3"]));
    expect(() => decodeCrate(bytes.subarray(0, bytes.length - 3))).toThrow(/runs past the end/);
  });
});
