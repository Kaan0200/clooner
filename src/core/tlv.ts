// The tag-length-value encoding shared by every Serato library file.
//
// A file is a flat sequence of fields. Each field is a 4-character ASCII
// tag, a 4-byte big-endian length, then `length` bytes of data. The tag's
// first letter gives the data type (see the Mixxx wiki, "Serato Database
// Format"):
//   o  nested fields       t, p  UTF-16BE text       b  1-byte flag
//   u  32-bit unsigned     s     16-bit value
// "vrsn" is the exception: it holds UTF-16BE text despite starting with "v".

export interface Field {
  tag: string;
  data: Uint8Array;
}

export function text(tag: string, value: string): Field {
  return { tag, data: encodeUtf16be(value) };
}

export function nested(tag: string, fields: Field[]): Field {
  return { tag, data: encodeFields(fields) };
}

export function flag(tag: string, on: boolean): Field {
  return { tag, data: Uint8Array.of(on ? 1 : 0) };
}

export function uint32(tag: string, value: number): Field {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value >>> 0);
  return { tag, data };
}

export function uint16(tag: string, value: number): Field {
  const data = new Uint8Array(2);
  new DataView(data.buffer).setUint16(0, value & 0xffff);
  return { tag, data };
}

/** The text of the first field with `tag`, or undefined when there is none. */
export function textOf(fields: Field[], tag: string): string | undefined {
  const field = fields.find((f) => f.tag === tag);
  return field && decodeUtf16be(field.data);
}

export function encodeFields(fields: Field[]): Uint8Array {
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

export function decodeFields(bytes: Uint8Array): Field[] {
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
export function encodeUtf16be(value: string): Uint8Array {
  const out = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

export function decodeUtf16be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error("UTF-16 text has an odd byte length");
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
  return String.fromCharCode(...units);
}
