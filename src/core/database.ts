// Serato "database V2" codec: the library cache Serato keeps next to its
// crates, at `<volume>/_Serato_/database V2`. Serato lists every track it
// knows on that volume here, with the tags it last read and some flags.
//
// Layout, as Serato writes it (observed on Windows):
//   vrsn  "2.0/Serato Scratch LIVE Database"
//   otrk  { ttyp <file type>, pfil <path>, tsng <title>, tart <artist>, ...
//           tadd <date added as text>, uadd <date added>, ulbl <colour>,
//           utme <file modified>, ufsb <file size>, sbav, b*** flags }
//
// The app never reads tags, so the records it adds carry only what the file
// system knows: the path, type, size and modification time. Serato fills the
// rest in from the file. Records Serato wrote are kept byte for byte, as are
// any fields this codec doesn't know, so a merged database is Serato's own
// database plus our tracks.

import {
  decodeFields,
  decodeUtf16be,
  encodeFields,
  flag,
  nested,
  text,
  textOf,
  uint16,
  uint32,
  type Field,
} from "./tlv";

export const DATABASE_VERSION = "2.0/Serato Scratch LIVE Database";

/** One track as Serato stores it: its fields, in order. */
export interface TrackRecord {
  kind: "track";
  fields: Field[];
}

/** A top-level field that isn't a track, kept as is. */
export interface OtherEntry {
  kind: "other";
  field: Field;
}

export interface Database {
  version: string;
  /** Everything after the version, in file order. */
  entries: (TrackRecord | OtherEntry)[];
}

export function newDatabase(): Database {
  return { version: DATABASE_VERSION, entries: [] };
}

export function encodeDatabase(db: Database): Uint8Array {
  const fields: Field[] = [text("vrsn", db.version)];
  for (const entry of db.entries) {
    fields.push(entry.kind === "track" ? nested("otrk", entry.fields) : entry.field);
  }
  return encodeFields(fields);
}

export function decodeDatabase(bytes: Uint8Array): Database {
  const db = newDatabase();
  for (const field of decodeFields(bytes)) {
    if (field.tag === "vrsn") db.version = decodeUtf16be(field.data);
    else if (field.tag === "otrk") db.entries.push({ kind: "track", fields: decodeFields(field.data) });
    else db.entries.push({ kind: "other", field });
  }
  return db;
}

/** The track's path relative to the volume root, or undefined for a record without one. */
export function trackPath(record: TrackRecord): string | undefined {
  return textOf(record.fields, "pfil");
}

/** Every track path in the database, in order. */
export function trackPaths(db: Database): string[] {
  const out: string[] = [];
  for (const entry of db.entries) {
    if (entry.kind !== "track") continue;
    const path = trackPath(entry);
    if (path !== undefined) out.push(path);
  }
  return out;
}

/** What the file system knows about a track that is to be added. */
export interface TrackInfo {
  /** Path relative to the volume root, "/"-separated, as Serato expects. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Modification time in milliseconds, or null when unknown. */
  mtime: number | null;
}

/** Serato's name for a file type, from the extension. */
export function seratoFileType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "wav":
      return "wave";
    case "aif":
      return "aiff";
    default:
      return ext;
  }
}

/** White: Serato's "no colour" label. */
const NO_COLOUR = 0xffffff;

/** Flags in the order Serato writes them, all off: nothing played, built or marked yet. */
const FLAGS = [
  "bhrt", "bmis", "bply", "blop", "bitu", "bovc", "bcrt",
  "biro", "bwlb", "bwll", "buns", "bbgl", "bkrk", "bstm",
];

/**
 * A record for a track Serato hasn't seen, with the fields Serato writes
 * for every track. `added` is when it joined the library, in milliseconds.
 */
export function newTrackRecord(track: TrackInfo, added: number): TrackRecord {
  const addedSeconds = Math.floor(added / 1000);
  const modifiedSeconds = Math.floor((track.mtime ?? added) / 1000);
  return {
    kind: "track",
    fields: [
      text("ttyp", seratoFileType(track.path)),
      text("pfil", track.path),
      text("tadd", String(addedSeconds)),
      uint32("uadd", addedSeconds),
      uint32("ulbl", NO_COLOUR),
      uint32("utme", modifiedSeconds),
      uint32("ufsb", track.size),
      uint16("sbav", 0),
      ...FLAGS.map((tag) => flag(tag, false)),
    ],
  };
}

export interface MergeResult {
  database: Database;
  /** How many of the given tracks were new to the database. */
  added: number;
}

/**
 * Adds records for the tracks the database doesn't have yet, matched by
 * path ignoring case since Serato runs on case-insensitive drives. Tracks
 * already there are left exactly as Serato wrote them.
 */
export function addTracks(db: Database, tracks: TrackInfo[], added: number): MergeResult {
  const known = new Set(trackPaths(db).map((p) => p.toLowerCase()));
  const entries = [...db.entries];
  let count = 0;
  for (const track of tracks) {
    const key = track.path.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    entries.push(newTrackRecord(track, added));
    count += 1;
  }
  return { database: { version: db.version, entries }, added: count };
}
