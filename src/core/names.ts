// Reversible encoding of file and folder names for exFAT, FAT and Windows.
//
// Disallowed characters become Unicode look-alikes (the scheme rclone uses),
// so names still read naturally:
//   \ / : * ? " < > |   ->  ＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜
//   control characters  ->  ␀ … ␟
//   trailing space/dot  ->  ␠ / ．
//   reserved names      ->  first letter full-width (CON.mp3 -> ＣON.mp3)
// A look-alike already present in the original name is prefixed with ‛ so
// that decoding is never ambiguous.

const ESCAPE = "‛"; // ‛

const CHAR_MAP: Record<string, string> = {
  "\\": "＼",
  "/": "／",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "＂",
  "<": "＜",
  ">": "＞",
  "|": "｜",
};
for (let code = 0; code < 0x20; code++) {
  CHAR_MAP[String.fromCharCode(code)] = String.fromCharCode(0x2400 + code);
}

const TRAILING_MAP: Record<string, string> = { " ": "␠", ".": "．" };

// Windows reserves these device names, with or without an extension.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
const RESERVED_FIRST = "CPANLcpanl";
const fullWidth = (c: string) => String.fromCharCode(c.charCodeAt(0) + 0xfee0);

const DECODE_MAP: Record<string, string> = {};
for (const [from, to] of Object.entries({ ...CHAR_MAP, ...TRAILING_MAP })) DECODE_MAP[to] = from;
for (const c of RESERVED_FIRST) DECODE_MAP[fullWidth(c)] = c;

/** Encode one name (no path separators are kept: "/" is encoded too). */
export function encodeName(name: string): string {
  const chars = Array.from(name).map((c) =>
    c === ESCAPE || c in DECODE_MAP ? ESCAPE + c : CHAR_MAP[c] ?? c,
  );

  const last = chars.length - 1;
  if (last >= 0 && chars[last] in TRAILING_MAP) chars[last] = TRAILING_MAP[chars[last]];
  if (RESERVED.test(name)) chars[0] = fullWidth(chars[0]);

  return chars.join("");
}

export function decodeName(encoded: string): string {
  let out = "";
  const chars = Array.from(encoded);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === ESCAPE && i + 1 < chars.length) out += chars[++i];
    else out += DECODE_MAP[c] ?? c;
  }
  return out;
}

/** Encode each segment of a "/"-separated relative path. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeName).join("/");
}

export function decodePath(path: string): string {
  return path.split("/").map(decodeName).join("/");
}
