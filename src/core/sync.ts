// Planning what goes into a clone.
//
// Two separate behaviours use this module:
//   - Dropping tracks on a crate copies those files into every connected
//     clone right away (`planTracks`).
//   - Sync writes the current crate contents as Serato `.crate` files into
//     the clone's `_Serato_` folder (`planCrates`).
// Both are pure; the I/O that carries them out lives in `lib/sync.ts`.

import { cloneTrackPath, normalizeRoot } from "./clone";
import { encodeName } from "./names";
import { isAbsolutePath, relativePath } from "./paths";
import type { CrateNode, CrateTree } from "./tree";

export interface TrackJob {
  /** Absolute path in the source library. */
  source: string;
  /** Path relative to the source root, unencoded. This is the track's identity. */
  relative: string;
  /** Absolute path inside the clone. */
  clonePath: string;
}

export interface TrackPlan {
  /** Each track once, even if it was given twice, in the order first seen. */
  tracks: TrackJob[];
  /** Tracks that aren't under the source root, so have no place in a clone. */
  outside: string[];
}

/**
 * Where each of some tracks belongs in the clone. Tracks are tree paths
 * (relative to the source root) or absolute paths; absolute paths outside
 * the root are set aside.
 */
export function planTracks(sourceRoot: string, cloneRoot: string, paths: string[]): TrackPlan {
  const root = normalizeRoot(sourceRoot);
  const unique = new Map<string, TrackJob>();
  const outside: string[] = [];
  for (const track of paths) {
    const relative = isAbsolutePath(track) ? relativePath(root, track) : normalizeRoot(track);
    const clonePath = relative === null ? null : cloneTrackPath(root, cloneRoot, relative);
    if (relative === null || clonePath === null) {
      outside.push(track);
      continue;
    }
    const key = relative.toLowerCase();
    if (!unique.has(key)) unique.set(key, { source: `${root}/${relative}`, relative, clonePath });
  }
  return { tracks: [...unique.values()], outside };
}

export interface CrateJob {
  /** The crate's path in the tree, outermost first. */
  names: string[];
  tracks: TrackJob[];
  /** Member tracks that aren't under the source root, so can't be in the clone. */
  outside: string[];
}

/** Every crate in the tree with its member tracks' places in the clone. */
export function planCrates(sourceRoot: string, cloneRoot: string, crates: CrateTree): CrateJob[] {
  const jobs: CrateJob[] = [];
  const walk = (nodes: CrateNode[], ancestors: string[]) => {
    for (const node of nodes) {
      const names = [...ancestors, node.name];
      const plan = planTracks(sourceRoot, cloneRoot, node.tracks);
      jobs.push({ names, tracks: plan.tracks, outside: plan.outside });
      walk(node.children, names);
    }
  };
  walk(crates, []);
  return jobs;
}

/** Size and modification time of a file, enough to notice it changed. */
export interface FileState {
  size: number;
  /** Modification time in milliseconds, or null when the platform gave none. */
  mtime: number | null;
}

/** Both sides of a track as they were right after the last copy. */
export interface SyncRecord {
  source: FileState;
  clone: FileState;
}

/** FAT and exFAT keep modification times to two seconds. */
export const MTIME_TOLERANCE_MS = 2000;

/** True when two states describe the same content, allowing for coarse timestamps. */
export function sameFile(a: FileState, b: FileState): boolean {
  if (a.size !== b.size) return false;
  if (a.mtime === null || b.mtime === null) return a.mtime === b.mtime;
  return Math.abs(a.mtime - b.mtime) <= MTIME_TOLERANCE_MS;
}

/**
 * A copy is needed when the clone lacks the file, when nothing is recorded
 * about the last copy, or when the source has changed since. Comparing with
 * the recorded source state rather than the clone's own timestamps keeps the
 * check honest on drives and platforms that don't preserve timestamps.
 */
export function needsCopy(
  previous: SyncRecord | undefined,
  current: FileState,
  presentInClone: boolean,
): boolean {
  if (!presentInClone || !previous) return true;
  return !sameFile(previous.source, current);
}

export type PushAction =
  /** The source's copy goes to the clone: the clone lacks it, or only the source changed. */
  | "copy"
  | "unchanged"
  /** The clone's copy changed since the last push, so it is left alone. */
  | "cloneChanged"
  /** Both copies changed since the last push; both are left alone. */
  | "bothChanged"
  /** Only the clone has the file. A pull can bring it in. */
  | "onlyClone"
  | "missing";

/**
 * What a push does with a track. A push only ever copies from the source to
 * the clone, and never over a file the clone changed: with a record of the
 * last copy, a changed clone copy is left alone and flagged; without one,
 * the newer file is taken to be the changed one.
 */
export function decidePush(
  record: SyncRecord | undefined,
  source: FileState | null,
  clone: FileState | null,
): PushAction {
  if (!source) return clone ? "onlyClone" : "missing";
  if (!clone) return "copy";
  if (record) {
    const sourceChanged = !sameFile(record.source, source);
    const cloneChanged = !sameFile(record.clone, clone);
    if (cloneChanged) return sourceChanged ? "bothChanged" : "cloneChanged";
    return sourceChanged ? "copy" : "unchanged";
  }
  if (sameFile(source, clone)) return "unchanged";
  return newer(source, clone) === "clone" ? "cloneChanged" : "copy";
}

export type PullAction =
  /** The clone's copy goes to the source: the source lacks it, or only the clone changed. */
  | "copy"
  | "unchanged"
  /** Both copies changed since the last push; neither is touched. */
  | "bothChanged"
  | "missing";

/**
 * What a pull does with a track. A pull only ever copies from the clone to
 * the source, and only files the clone changed: a file changed on both
 * sides is left for the user to decide.
 */
export function decidePull(
  record: SyncRecord | undefined,
  source: FileState | null,
  clone: FileState | null,
): PullAction {
  if (!clone) return source ? "unchanged" : "missing";
  if (!source) return "copy";
  if (record) {
    const sourceChanged = !sameFile(record.source, source);
    const cloneChanged = !sameFile(record.clone, clone);
    if (!cloneChanged) return "unchanged";
    return sourceChanged ? "bothChanged" : "copy";
  }
  if (sameFile(source, clone)) return "unchanged";
  return newer(source, clone) === "clone" ? "copy" : "unchanged";
}

/** Which copy is newer by modification time; the source on ties and unknown times. */
function newer(source: FileState, clone: FileState): "source" | "clone" {
  if (source.mtime === null || clone.mtime === null) return "source";
  return clone.mtime - source.mtime > MTIME_TOLERANCE_MS ? "clone" : "source";
}

/**
 * The volume a path lives on: "E:" for a drive letter, "/Volumes/Name" on
 * macOS, "/" otherwise. Serato keeps its crates at `<volume>/_Serato_`.
 */
export function volumeRoot(path: string): string {
  const p = normalizeRoot(path);
  const drive = /^[A-Za-z]:/.exec(p);
  if (drive) return drive[0];
  const volume = /^\/Volumes\/[^/]+/.exec(p);
  if (volume) return volume[0];
  return "/";
}

/** The path relative to its volume root, "/"-separated and without a leading slash. */
export function volumeRelative(path: string): string {
  const p = normalizeRoot(path);
  return p.slice(volumeRoot(p).length).replace(/^\/+/, "");
}

/**
 * The `_Serato_` folder Serato reads for the clone: at the root of the
 * clone's volume, not inside the clone. Serato only looks there.
 */
export function seratoFolder(cloneRoot: string): string {
  return `${volumeRoot(cloneRoot).replace(/\/$/, "")}/_Serato_`;
}

/** Where the crate files go. */
export function seratoSubcratesFolder(cloneRoot: string): string {
  return `${seratoFolder(cloneRoot)}/Subcrates`;
}

/** Serato's library cache for the volume. */
export function seratoDatabaseFile(cloneRoot: string): string {
  return `${seratoFolder(cloneRoot)}/database V2`;
}

/** The `.crate` file for a crate: levels joined with `%%`, Serato's subcrate separator. */
export function seratoCrateFile(cloneRoot: string, names: string[]): string {
  return `${seratoSubcratesFolder(cloneRoot)}/${names.map(encodeName).join("%%")}.crate`;
}
