// The application database: what this computer remembers between launches.
//
// It is one JSON document holding where the source is, which clones are
// known, and a copy of the source's manifest (the library). The manifest at
// the source root is the truth; the copy here lets the app show and edit
// the crates while the source folder is away, and is written back to the
// root when the folder returns. This module only knows the shape and how to
// read it tolerantly; where it lives on disk is the store's business.

import type { Conflict } from "./issues";
import { manifestFrom, newSourceManifest, type Manifest } from "./manifest";
import { baseName, trackPath } from "./paths";
import type { CrateTree } from "./tree";

export const DB_VERSION = 2;

export interface SourceEntry {
  /** Absolute path of the library root. */
  path: string;
  /** When it was added, ISO 8601. */
  added: string;
}

export interface CloneEntry {
  /** Absolute path of the clone root. */
  path: string;
  /** The clone's location id from its manifest, once it has been read. */
  id: string | null;
  /** When it was added, ISO 8601. */
  added: string;
  /** When it was last pushed to from the source, ISO 8601, or null if never. */
  lastSync: string | null;
  /** Files the last push or pull left alone because the clone's copy had changed. */
  conflicts: Conflict[];
}

export interface AppDb {
  version: typeof DB_VERSION;
  source: SourceEntry | null;
  clones: CloneEntry[];
  /** The source's manifest as last read from its root or edited here. Null until there are crates. */
  library: Manifest | null;
  /** The revision the root's manifest had when `library` was last read from or written to it. */
  baseRevision: number;
  /** True when `library` holds changes not yet written to the source root. */
  dirty: boolean;
}

export function emptyDb(): AppDb {
  return { version: DB_VERSION, source: null, clones: [], library: null, baseRevision: 0, dirty: false };
}

export function serializeDb(db: AppDb): string {
  return JSON.stringify(db, null, 2) + "\n";
}

/**
 * Parses a saved database. Missing or malformed sections fall back to empty
 * rather than failing the whole load, so a field added in a later version
 * never locks a user out. A version 1 database, which kept the crate tree
 * and track lengths itself, is turned into a library manifest to be written
 * to the source root. Throws only when the text isn't a JSON object at all,
 * or claims a version this build can't read.
 */
export function parseDb(text: string): AppDb {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The database file isn't valid JSON.");
  }
  if (!isRecord(raw)) throw new Error("The database file isn't a JSON object.");

  const version = typeof raw.version === "number" ? raw.version : DB_VERSION;
  if (version > DB_VERSION) {
    throw new Error(`The database was written by a newer clooner (version ${version}).`);
  }

  const source = parseSource(raw.source);
  const clones = Array.isArray(raw.clones) ? raw.clones.flatMap((c) => optional(parseClone(c))) : [];
  if (version < 2) return upgradeV1(raw, source, clones);

  let library: Manifest | null = null;
  if (raw.library !== null && raw.library !== undefined) {
    try {
      library = manifestFrom(raw.library);
    } catch {
      library = null;
    }
  }
  return {
    version: DB_VERSION,
    source,
    clones,
    library,
    baseRevision: typeof raw.baseRevision === "number" ? raw.baseRevision : 0,
    dirty: raw.dirty === true,
  };
}

/**
 * A version 1 database held the crate tree with absolute track paths and
 * the track lengths. They become a source manifest, with paths made
 * relative to the source root, marked dirty so it is written to the root.
 */
function upgradeV1(raw: Record<string, unknown>, source: SourceEntry | null, clones: CloneEntry[]): AppDb {
  const crates = relativizeTree(parseCratesLoose(raw.crates), source?.path ?? null);
  const hasCrates = crates.length > 0;
  if (!hasCrates && !source) {
    return { version: DB_VERSION, source, clones, library: null, baseRevision: 0, dirty: false };
  }
  const library = newSourceManifest(source ? baseName(source.path) : "", crates);
  if (isRecord(raw.durations)) {
    for (const [key, seconds] of Object.entries(raw.durations)) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) continue;
      const relative = trackPath(source?.path ?? null, key);
      library.tracks[relative.toLowerCase()] = { duration: seconds };
    }
  }
  return {
    version: DB_VERSION,
    source,
    clones: clones.map((c) => ({
      ...c,
      conflicts: c.conflicts.map((k) => ({ ...k, path: trackPath(source?.path ?? null, k.path) })),
    })),
    library,
    baseRevision: 0,
    dirty: true,
  };
}

function relativizeTree(tree: CrateTree, root: string | null): CrateTree {
  return tree.map((node) => ({
    ...node,
    tracks: node.tracks.map((t) => trackPath(root, t)),
    children: relativizeTree(node.children, root),
  }));
}

function parseCratesLoose(value: unknown): CrateTree {
  try {
    return manifestFrom({ kind: "source", locationId: "x", crates: value }).crates;
  } catch {
    return [];
  }
}

function parseSource(value: unknown): SourceEntry | null {
  if (!isRecord(value) || typeof value.path !== "string" || value.path === "") return null;
  return { path: value.path, added: isoOr(value.added) };
}

function parseClone(value: unknown): CloneEntry | null {
  if (!isRecord(value) || typeof value.path !== "string" || value.path === "") return null;
  return {
    path: value.path,
    id: typeof value.id === "string" ? value.id : null,
    added: isoOr(value.added),
    lastSync: typeof value.lastSync === "string" ? value.lastSync : null,
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.flatMap((c) => optional(parseConflict(c))) : [],
  };
}

function parseConflict(value: unknown): Conflict | null {
  if (!isRecord(value) || typeof value.path !== "string" || value.path === "") return null;
  return {
    path: value.path,
    changed: value.changed === "both" ? "both" : "clone",
    when: isoOr(value.when),
  };
}

function isoOr(value: unknown): string {
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional<T>(value: T | null): T[] {
  return value === null ? [] : [value];
}
