// The manifest: the file at a location's root that makes it self-describing.
//
// Every location, source or clone, has a `clooner.json` at its root holding
// the library (crate tree and per-track facts), who the location is, which
// revision of the library it has, and what it last agreed with each peer.
// The source's copy is the truth; the app database on a computer only
// caches it. A clone's copy lets a computer that has never seen the library
// open the clone and learn everything from it.
//
// Clone markers written before this shape (version 1) are upgraded on read.

import type { SyncRecord } from "./sync";
import type { CrateTree } from "./tree";

export const MANIFEST_VERSION = 2;
export const MANIFEST_FILE = "clooner.json";

export type LocationKind = "source" | "clone";

/** Facts about one track that travel with the library. */
export interface TrackEntry {
  /** Length in seconds, when it has been read. */
  duration?: number;
}

/** Another location this one has synced with. */
export interface Peer {
  name: string;
  kind: LocationKind;
  /** The library revision both sides agreed on at the last sync. */
  revision: number;
  /** When they last synced, ISO 8601, or null when never. */
  lastSync: string | null;
  /** Where the peer was last seen from this location. A hint, not an identity. */
  path: string | null;
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  kind: LocationKind;
  /** Shared by every location of one library. Null on an old clone until it meets its source. */
  libraryId: string | null;
  /** This location's own id, kept across drive letters and computers. */
  locationId: string;
  /** What the DJ calls this location. */
  name: string;
  /** When the location was created, ISO 8601. */
  created: string;
  /**
   * On the source: the library's revision, bumped on every crate change.
   * On a clone: the source revision its crates are based on.
   */
  revision: number;
  /** The crate tree. Track paths are relative to the library root (see core/paths.ts). */
  crates: CrateTree;
  /** Per-track facts, keyed by track key (the path, case-folded). */
  tracks: Record<string, TrackEntry>;
  /** Locations this one has synced with, keyed by their location id. */
  peers: Record<string, Peer>;
  /**
   * Clone only: both sides of each copied track as of its last copy, keyed
   * by the track's relative path. Task 8 replaces these with stamps.
   */
  synced: Record<string, SyncRecord>;
}

/** The manifest's path for a location root. */
export function manifestPath(root: string): string {
  return `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${MANIFEST_FILE}`;
}

/** A fresh source manifest for a library that has just been given a root. */
export function newSourceManifest(name: string, crates: CrateTree = [], now = new Date()): Manifest {
  return {
    version: MANIFEST_VERSION,
    kind: "source",
    libraryId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    name,
    created: now.toISOString(),
    revision: 1,
    crates,
    tracks: {},
    peers: {},
    synced: {},
  };
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Reads a manifest tolerantly: missing or malformed sections fall back to
 * empty, and a version 1 clone marker is upgraded. Throws when the text
 * isn't a clooner manifest at all, or was written by a newer build.
 */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The clooner.json file isn't valid JSON.");
  }
  return manifestFrom(raw);
}

/** Builds a manifest from already-parsed JSON. See `parseManifest`. */
export function manifestFrom(raw: unknown): Manifest {
  if (!isRecord(raw)) throw new Error("The clooner.json file isn't a JSON object.");
  const version = typeof raw.version === "number" ? raw.version : MANIFEST_VERSION;
  if (version > MANIFEST_VERSION) {
    throw new Error(`The clooner.json file was written by a newer clooner (version ${version}).`);
  }
  if (raw.kind !== "source" && raw.kind !== "clone") {
    throw new Error("The clooner.json file isn't a clooner location.");
  }

  // Version 1 markers named the clone's id `id` and knew only a source path.
  const locationId = stringOr(raw.locationId) ?? stringOr(raw.id);
  if (!locationId) throw new Error("The clooner.json file has no location id.");

  return {
    version: MANIFEST_VERSION,
    kind: raw.kind,
    libraryId: stringOr(raw.libraryId) ?? null,
    locationId,
    name: stringOr(raw.name) ?? "",
    created: stringOr(raw.created) ?? new Date(0).toISOString(),
    revision: typeof raw.revision === "number" && raw.revision >= 0 ? Math.floor(raw.revision) : 0,
    crates: parseCrates(raw.crates),
    tracks: parseTracks(raw.tracks),
    peers: parsePeers(raw.peers),
    synced: parseSynced(raw.synced),
  };
}

function parseTracks(value: unknown): Record<string, TrackEntry> {
  if (!isRecord(value)) return {};
  const out: Record<string, TrackEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const track: TrackEntry = {};
    if (typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0) {
      track.duration = entry.duration;
    }
    out[key] = track;
  }
  return out;
}

function parsePeers(value: unknown): Record<string, Peer> {
  if (!isRecord(value)) return {};
  const out: Record<string, Peer> = {};
  for (const [id, peer] of Object.entries(value)) {
    if (!isRecord(peer) || id === "") continue;
    out[id] = {
      name: stringOr(peer.name) ?? "",
      kind: peer.kind === "clone" ? "clone" : "source",
      revision: typeof peer.revision === "number" && peer.revision >= 0 ? Math.floor(peer.revision) : 0,
      lastSync: stringOr(peer.lastSync) ?? null,
      path: stringOr(peer.path) ?? null,
    };
  }
  return out;
}

/** Older markers held only the source's state per track; both sides are set to it. */
function parseSynced(value: unknown): Record<string, SyncRecord> {
  if (!isRecord(value)) return {};
  const out: Record<string, SyncRecord> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!isRecord(record)) continue;
    if ("source" in record) {
      const source = parseState(record.source);
      const clone = parseState(record.clone);
      if (source && clone) out[key] = { source, clone };
    } else {
      const state = parseState(record);
      if (state) out[key] = { source: state, clone: state };
    }
  }
  return out;
}

function parseState(value: unknown): SyncRecord["source"] | null {
  if (!isRecord(value) || typeof value.size !== "number") return null;
  return { size: value.size, mtime: typeof value.mtime === "number" ? value.mtime : null };
}

/** Crates with a usable id and name; a missing id is minted, a duplicate dropped. */
export function parseCrates(value: unknown): CrateTree {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const parse = (node: unknown): CrateTree => {
    if (!isRecord(node) || typeof node.name !== "string") return [];
    const id = typeof node.id === "string" && node.id !== "" ? node.id : crypto.randomUUID();
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: node.name,
        children: Array.isArray(node.children) ? node.children.flatMap(parse) : [],
        tracks: Array.isArray(node.tracks) ? node.tracks.filter((t): t is string => typeof t === "string") : [],
      },
    ];
  };
  return value.flatMap(parse);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
