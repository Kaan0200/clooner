// Getting tracks and crates onto a clone, and edits back to the source.
//
// Two separate behaviours:
//   - `copyTracks` puts source files into the clone's `Tracks/`. It runs the
//     moment tracks are dropped on a crate, for every connected clone.
//   - `syncClone` is what the Sync button does. For every track in a crate
//     it compares the source and clone files and copies the newer one over
//     the other, so an edit on either side spreads. Then it writes the
//     current crate contents as Serato `.crate` files into `_Serato_`.
//
// Every copy records both sides' size and modification time in the clone's
// `clooner.json`, so the next sync can tell which side actually changed.

import { copyFile, exists, mkdir, stat, writeFile } from "@tauri-apps/plugin-fs";
import { encodeCrate, newCrate } from "@/core/crate";
import {
  decideSync,
  needsCopy,
  planCrates,
  planTracks,
  seratoCrateFile,
  seratoSubcratesFolder,
  volumeRelative,
  type FileState,
  type SyncRecord,
  type TrackJob,
} from "@/core/sync";
import type { CrateTree } from "@/core/tree";
import {
  cloneMarker,
  forEachConcurrent,
  readCloneDb,
  writeCloneDb,
  type CloneDb,
} from "@/lib/library";

export interface CopySummary {
  copied: number;
  /** Already in the clone and unchanged at the source since. */
  unchanged: number;
  /** Tracks whose source file couldn't be read. */
  missing: number;
  /** Tracks outside the source library, which have no place in a clone. */
  outside: number;
  /** When the copy finished, ISO 8601. */
  finished: string;
}

/**
 * Copies some source tracks into the clone, skipping files whose source
 * hasn't changed since they were last copied, and records what was copied
 * in the clone's `clooner.json`.
 */
export async function copyTracks(
  sourceRoot: string,
  cloneRoot: string,
  paths: string[],
  onProgress: (message: string) => void,
): Promise<CopySummary> {
  const db = await readCloneDb(cloneMarker(cloneRoot));
  if (!db) throw new Error("That folder isn't an attached clone.");

  const plan = planTracks(sourceRoot, cloneRoot, paths);
  const synced = syncRecords(db);
  const summary: CopySummary = {
    copied: 0,
    unchanged: 0,
    missing: 0,
    outside: plan.outside.length,
    finished: "",
  };

  let started = 0;
  await forEachConcurrent(plan.tracks, 4, async (track) => {
    started += 1;
    onProgress(
      `Copying ${started.toLocaleString()} / ${plan.tracks.length.toLocaleString()}: ${fileName(track.source)}`,
    );
    const source = await fileState(track.source);
    if (!source) {
      summary.missing += 1;
      return;
    }

    if (needsCopy(synced[track.relative], source, await exists(track.clonePath))) {
      synced[track.relative] = await copy(track.source, track.clonePath);
      summary.copied += 1;
    } else {
      summary.unchanged += 1;
    }
  });

  summary.finished = new Date().toISOString();
  if (summary.copied > 0) await writeCloneDb(cloneRoot, { ...db, synced });
  return summary;
}

export interface SyncConflict {
  /** The track's source path. */
  path: string;
  kept: "source" | "clone";
}

export interface SyncSummary {
  /** Files copied from the source into the clone. */
  toClone: number;
  /** Files copied from the clone back into the source. */
  toSource: number;
  /** Files identical on both sides. */
  unchanged: number;
  /** Files that had changed on both sides; the newer one was kept. */
  bothChanged: number;
  /** Which files those were, and whose copy won. */
  conflicts: SyncConflict[];
  /** Crate members missing from both the source and the clone. */
  missing: number;
  /** Crate members outside the source library, left out of the crate files. */
  outside: number;
  /** Crate files written. */
  crates: number;
  /** When the sync finished, ISO 8601. */
  finished: string;
}

/**
 * Reconciles every crate member between the source and the clone, newer
 * file winning, then writes one Serato `.crate` file per crate into the
 * clone's `_Serato_/Subcrates`. Members are listed where they live in the
 * clone, relative to the volume root as Serato expects, even when the file
 * is missing, since the crate is the truth.
 */
export async function syncClone(
  sourceRoot: string,
  cloneRoot: string,
  crates: CrateTree,
  onProgress: (message: string) => void,
): Promise<SyncSummary> {
  const db = await readCloneDb(cloneMarker(cloneRoot));
  if (!db) throw new Error("That folder isn't an attached clone.");

  const jobs = planCrates(sourceRoot, cloneRoot, crates);
  const synced = syncRecords(db);
  const summary: SyncSummary = {
    toClone: 0,
    toSource: 0,
    unchanged: 0,
    bothChanged: 0,
    conflicts: [],
    missing: 0,
    outside: 0,
    crates: 0,
    finished: "",
  };

  // 1. Files. Each track once, even when several crates hold it.
  const unique = new Map<string, TrackJob>();
  for (const job of jobs) {
    summary.outside += job.outside.length;
    for (const track of job.tracks) {
      const key = track.relative.toLowerCase();
      if (!unique.has(key)) unique.set(key, track);
    }
  }
  const tracks = [...unique.values()];
  let started = 0;
  await forEachConcurrent(tracks, 4, async (track) => {
    started += 1;
    onProgress(
      `Checking ${started.toLocaleString()} / ${tracks.length.toLocaleString()}: ${fileName(track.source)}`,
    );
    const [source, clone] = await Promise.all([
      fileState(track.source),
      fileState(track.clonePath),
    ]);
    const decision = decideSync(synced[track.relative], source, clone);
    if (decision.bothChanged) {
      summary.bothChanged += 1;
      summary.conflicts.push({
        path: track.source,
        kept: decision.direction === "toSource" ? "clone" : "source",
      });
    }
    switch (decision.direction) {
      case "toClone":
        synced[track.relative] = await copy(track.source, track.clonePath);
        summary.toClone += 1;
        break;
      case "toSource":
        synced[track.relative] = reversed(await copy(track.clonePath, track.source));
        summary.toSource += 1;
        break;
      case "none":
        synced[track.relative] = { source: source!, clone: clone! };
        summary.unchanged += 1;
        break;
      case "missing":
        summary.missing += 1;
        break;
    }
  });

  // 2. Crate files.
  await mkdir(seratoSubcratesFolder(cloneRoot), { recursive: true });
  for (const job of jobs) {
    onProgress(`Writing crate: ${job.names.join(" / ")}`);
    const paths = job.tracks.map((t) => volumeRelative(t.clonePath));
    await writeFile(seratoCrateFile(cloneRoot, job.names), encodeCrate(newCrate(paths)));
    summary.crates += 1;
  }

  summary.finished = new Date().toISOString();
  await writeCloneDb(cloneRoot, { ...db, lastSync: summary.finished, synced });
  return summary;
}

/** The clone's copy records, upgrading entries older markers wrote with only the source state. */
function syncRecords(db: CloneDb): Record<string, SyncRecord> {
  const out: Record<string, SyncRecord> = {};
  for (const [key, value] of Object.entries(db.synced ?? {})) {
    out[key] = "source" in value ? value : { source: value, clone: value };
  }
  return out;
}

/** Copies `from` over `to`, creating folders as needed, and reports both sides afterwards. */
async function copy(from: string, to: string): Promise<SyncRecord> {
  await mkdir(parentOf(to), { recursive: true });
  await copyFile(from, to);
  const [source, clone] = await Promise.all([fileState(from), fileState(to)]);
  return { source: source!, clone: clone! };
}

/** A record made by copying clone to source has its sides swapped. */
function reversed(record: SyncRecord): SyncRecord {
  return { source: record.clone, clone: record.source };
}

/** The file's size and modification time, or null when it can't be read. */
async function fileState(path: string): Promise<FileState | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtime: info.mtime?.getTime() ?? null };
  } catch {
    return null;
  }
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(0, normalized.lastIndexOf("/"));
}
