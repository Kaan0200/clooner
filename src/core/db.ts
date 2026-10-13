// The application database: what the app remembers between launches.
//
// It is one JSON document holding the source library, the clones, and the
// crate tree. This module only knows the shape and how to read it
// tolerantly; where it lives on disk is the store's business.

import type { CrateNode, CrateTree } from "./tree";

export const DB_VERSION = 1;

export interface SourceEntry {
  /** Absolute path of the library root. */
  path: string;
  /** When it was added, ISO 8601. */
  added: string;
}

export interface CloneEntry {
  /** Absolute path of the clone root. */
  path: string;
  /** The id from the clone's own `clooner.json`, once it has been read. */
  id: string | null;
  /** When it was added, ISO 8601. */
  added: string;
  /** When it was last synced from the source, ISO 8601, or null if never. */
  lastSync: string | null;
}

export interface AppDb {
  version: typeof DB_VERSION;
  source: SourceEntry | null;
  clones: CloneEntry[];
  crates: CrateTree;
}

export function emptyDb(): AppDb {
  return { version: DB_VERSION, source: null, clones: [], crates: [] };
}

export function serializeDb(db: AppDb): string {
  return JSON.stringify(db, null, 2) + "\n";
}

/**
 * Parses a saved database. Missing or malformed sections fall back to empty
 * rather than failing the whole load, so a field added in a later version
 * never locks a user out. Throws only when the text isn't a JSON object at
 * all, or claims a version this build can't read.
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

  return {
    version: DB_VERSION,
    source: parseSource(raw.source),
    clones: Array.isArray(raw.clones) ? raw.clones.flatMap((c) => optional(parseClone(c))) : [],
    crates: parseCrates(raw.crates),
  };
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
  };
}

function parseCrates(value: unknown): CrateTree {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((n) => optional(parseCrate(n, seen)));
}

function parseCrate(value: unknown, seen: Set<string>): CrateNode | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  // A crate without a usable id gets a fresh one; a duplicate would break
  // selection and editing, so it is dropped.
  const id = typeof value.id === "string" && value.id !== "" ? value.id : crypto.randomUUID();
  if (seen.has(id)) return null;
  seen.add(id);
  return {
    id,
    name: value.name,
    children: Array.isArray(value.children)
      ? value.children.flatMap((c) => optional(parseCrate(c, seen)))
      : [],
    tracks: Array.isArray(value.tracks)
      ? value.tracks.filter((t): t is string => typeof t === "string")
      : [],
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
