// Planning a one-way sync from the source library into a clone.
//
// The plan is pure: given the roots and the crate tree it works out which
// files belong in the clone, where each goes, and what generated files are
// needed. The I/O that carries it out lives in `lib/sync.ts`.

import { cloneCrateFolder, cloneTrackPath, normalizeRoot } from "./clone";
import { titleOf } from "./m3u";
import { encodeName } from "./names";
import type { CrateNode, CrateTree } from "./tree";

export interface TrackJob {
  /** Absolute path in the source library. */
  source: string;
  /** Path relative to the source root, unencoded. This is the track's identity. */
  relative: string;
  /** Absolute path inside the clone. */
  clonePath: string;
}

export interface CrateJob {
  /** The crate's path in the tree, outermost first. */
  names: string[];
  tracks: TrackJob[];
  /** Member tracks that aren't under the source root, so can't be cloned. */
  outside: string[];
  /** One stub playlist per track: its file inside the crate's folder. */
  stubs: { file: string; track: TrackJob }[];
}

export interface SyncPlan {
  crates: CrateJob[];
  /** Every track to copy, once each even when it is in several crates. */
  tracks: TrackJob[];
  outside: string[];
}

export function planSync(sourceRoot: string, cloneRoot: string, crates: CrateTree): SyncPlan {
  const root = normalizeRoot(sourceRoot);
  const jobs: CrateJob[] = [];
  const unique = new Map<string, TrackJob>();
  const outside = new Set<string>();

  const walk = (nodes: CrateNode[], ancestors: string[]) => {
    for (const node of nodes) {
      const names = [...ancestors, node.name];
      const job: CrateJob = { names, tracks: [], outside: [], stubs: [] };
      for (const track of node.tracks) {
        const clonePath = cloneTrackPath(root, cloneRoot, track);
        if (clonePath === null) {
          job.outside.push(track);
          outside.add(track);
          continue;
        }
        const relative = normalizeRoot(track).slice(root.length + 1);
        const key = relative.toLowerCase();
        const existing = unique.get(key);
        const trackJob = existing ?? { source: track, relative, clonePath };
        if (!existing) unique.set(key, trackJob);
        job.tracks.push(trackJob);
      }
      job.stubs = stubFiles(cloneRoot, names, job.tracks);
      jobs.push(job);
      walk(node.children, names);
    }
  };
  walk(crates, []);

  return { crates: jobs, tracks: [...unique.values()], outside: [...outside] };
}

/**
 * One `.m3u` per track inside the crate's folder, named after the track's
 * file. Two tracks with the same file name in different folders get a
 * numbered suffix so neither overwrites the other.
 */
function stubFiles(cloneRoot: string, names: string[], tracks: TrackJob[]) {
  const folder = cloneCrateFolder(cloneRoot, names);
  const used = new Set<string>();
  return tracks.map((track) => {
    const base = titleOf(track.source);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    return { file: `${folder}/${encodeName(name)}.m3u`, track };
  });
}

/** What was known about a source file when it was last copied. */
export interface SyncedEntry {
  size: number;
  /** Modification time in milliseconds, or null when the platform gave none. */
  mtime: number | null;
}

/**
 * A copy is needed when the clone lacks the file, when nothing is recorded
 * about the last copy, or when the source has changed since. Comparing with
 * the recorded source state rather than the clone's own timestamps keeps the
 * check honest on drives and platforms that don't preserve timestamps.
 */
export function needsCopy(
  previous: SyncedEntry | undefined,
  current: SyncedEntry,
  presentInClone: boolean,
): boolean {
  if (!presentInClone || !previous) return true;
  return previous.size !== current.size || previous.mtime !== current.mtime;
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

/** The clone's `_Serato_/Subcrates` folder. */
export function seratoSubcratesFolder(cloneRoot: string): string {
  return `${normalizeRoot(cloneRoot)}/_Serato_/Subcrates`;
}

/** The `.crate` file for a crate: levels joined with `%%`, Serato's subcrate separator. */
export function seratoCrateFile(cloneRoot: string, names: string[]): string {
  return `${seratoSubcratesFolder(cloneRoot)}/${names.map(encodeName).join("%%")}.crate`;
}
