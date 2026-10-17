// Serato .crate codec. Field encoding is shared with the database in `tlv.ts`.
//
// Layout written by Serato:
//   vrsn  "1.0/Serato ScratchLive Crate"
//   osrt  { tvcn <column name>, brev <reverse flag> }       sort order
//   ovct  { tvcn <column name>, tvcw <width text> }          one per column
//   otrk  { ptrk <track path> }                              one per track

import { decodeFields, decodeUtf16be, encodeFields, flag, nested, text, textOf, type Field } from "./tlv";

export interface Column {
  name: string;
  width: string;
}

export interface Crate {
  version: string;
  sort: { column: string; reverse: boolean };
  columns: Column[];
  /** Track paths relative to the volume root, using "/". */
  tracks: string[];
}

export const DEFAULT_VERSION = "1.0/Serato ScratchLive Crate";

export function newCrate(tracks: string[] = []): Crate {
  return {
    version: DEFAULT_VERSION,
    sort: { column: "song", reverse: false },
    columns: ["song", "artist", "album", "length"].map((name) => ({ name, width: "0" })),
    tracks,
  };
}

export function encodeCrate(crate: Crate): Uint8Array {
  const fields: Field[] = [
    text("vrsn", crate.version),
    nested("osrt", [text("tvcn", crate.sort.column), flag("brev", crate.sort.reverse)]),
    ...crate.columns.map((c) => nested("ovct", [text("tvcn", c.name), text("tvcw", c.width)])),
    ...crate.tracks.map((t) => nested("otrk", [text("ptrk", t)])),
  ];
  return encodeFields(fields);
}

export function decodeCrate(bytes: Uint8Array): Crate {
  const crate: Crate = { ...newCrate(), columns: [] };

  for (const field of decodeFields(bytes)) {
    switch (field.tag) {
      case "vrsn":
        crate.version = decodeUtf16be(field.data);
        break;
      case "osrt": {
        const sub = decodeFields(field.data);
        crate.sort = {
          column: textOf(sub, "tvcn") ?? crate.sort.column,
          reverse: (sub.find((f) => f.tag === "brev")?.data[0] ?? 0) !== 0,
        };
        break;
      }
      case "ovct": {
        const sub = decodeFields(field.data);
        crate.columns.push({ name: textOf(sub, "tvcn") ?? "", width: textOf(sub, "tvcw") ?? "0" });
        break;
      }
      case "otrk": {
        const path = textOf(decodeFields(field.data), "ptrk");
        if (path !== undefined) crate.tracks.push(path);
        break;
      }
      // Unknown fields are skipped.
    }
  }

  return crate;
}
