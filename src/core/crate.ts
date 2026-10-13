// Serato .crate codec.
//
// A crate file is a flat list of fields. Each field is a 4-character ASCII
// tag, a 4-byte big-endian length, then `length` bytes of data. The tag's
// first letter gives the data type (see the Mixxx wiki, "Serato Database
// Format"):
//   o  nested fields       t, p  UTF-16BE text       b  1-byte flag
// "vrsn" is the exception: it holds UTF-16BE text despite starting with "v".
//
// Layout written by Serato:
//   vrsn  "1.0/Serato ScratchLive Crate"
//   osrt  { tvcn <column name>, brev <reverse flag> }       sort order
//   ovct  { tvcn <column name>, tvcw <width text> }          one per column
//   otrk  { ptrk <track path> }                              one per track

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

interface Field {
  tag: string;
  data: Uint8Array;
}

export function encodeCrate(crate: Crate): Uint8Array {
  const fields: Field[] = [
    text("vrsn", crate.version),
    nested("osrt", [
      text("tvcn", crate.sort.column),
      { tag: "brev", data: Uint8Array.of(crate.sort.reverse ? 1 : 0) },
    ]),
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

function text(tag: string, value: string): Field {
  return { tag, data: encodeUtf16be(value) };
}

function nested(tag: string, fields: Field[]): Field {
  return { tag, data: encodeFields(fields) };
}

function textOf(fields: Field[], tag: string): string | undefined {
  const field = fields.find((f) => f.tag === tag);
  return field && decodeUtf16be(field.data);
}

function encodeFields(fields: Field[]): Uint8Array {
  const size = fields.reduce((n, f) => n + 8 + f.data.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const { tag, data } of fields) {
    for (let i = 0; i < 4; i++) out[pos + i] = tag.charCodeAt(i);
    view.setUint32(pos + 4, data.length);
    out.set(data, pos + 8);
    pos += 8 + data.length;
  }
  return out;
}

function decodeFields(bytes: Uint8Array): Field[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: Field[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw new Error(`Truncated field header at byte ${pos}`);
    const tag = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const length = view.getUint32(pos + 4);
    const end = pos + 8 + length;
    if (end > bytes.length) throw new Error(`Field ${tag} at byte ${pos} runs past the end`);
    fields.push({ tag, data: bytes.subarray(pos + 8, end) });
    pos = end;
  }
  return fields;
}

// JS strings are UTF-16 code units, so lengths are correct for characters
// outside the BMP (emoji) without any special handling.
function encodeUtf16be(value: string): Uint8Array {
  const out = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function decodeUtf16be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error("UTF-16 text has an odd byte length");
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
  return String.fromCharCode(...units);
}
