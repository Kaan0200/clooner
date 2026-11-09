// Getting tracks and crates onto a clone, and edits made there back.
//
// Three behaviours, each one-way:
//   - `copyTracks` puts source files into the clone's `Tracks/`. It runs the
//     moment tracks are dropped on a crate, for every connected clone.
//   - `pushClone` is the Push button. The clone ends up matching the
//     library: files it lacks or that changed at the source are copied in,
//     the current crate contents are written as Serato `.crate` files into
//     the `_Serato_` folder at the root of the clone's drive, and the tracks
//     are added to the `database V2` there. A file the clone changed since
//     the last push is never overwritten; it is flagged instead.
//   - `planPull` and `applyPull` are the Pull button. Files the clone changed
//     or added are listed, and once the user agrees, copied into the
//     library. A file changed on both sides is left for the user.
//
// Every copy records both sides' size and modification time in the clone's
// manifest, so the next push or pull can tell which side actually changed.
// A push also writes the source's crates and revision into the clone's
// manifest, so the clone describes the library on its own.
//
// Files follow moves without being copied again: when a track's place in
// the clone is empty but a file with its name sits elsewhere under
// `Tracks/`, it is renamed into place first (see core/relink.ts).

import { copyFile, exists, mkdir, readFile, rename, stat, writeFile } from "@tauri-apps/plugin-fs";
import { encodeCrate, newCrate } from "@/core/crate";
import {
  addTracks,
  decodeDatabase,
  encodeDatabase,
  newDatabase,
  type TrackInfo,
} from "@/core/database";
import { normalizeRoot } from "@/core/clone";
import type { Conflict } from "@/core/issues";
import type { Manifest } from "@/core/manifest";
import { decodePath, encodePath } from "@/core/names";
import { buildIndex, matchTrack } from "@/core/relink";
import {
  decidePull,
  decidePush,
  needsCopy,
  planCrates,
  planTracks,
  seratoCrateFile,
  seratoDatabaseFile,
  seratoSubcratesFolder,
  volumeRelative,
  type FileState,
  type SyncRecord,
  type TrackJob,
} from "@/core/sync";
import { forEachConcurrent, readManifestAt, scanLibrary, writeManifestAt } from "@/lib/library";

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
 * Copies some tracks (tree paths) into the clone, skipping files whose
 * source hasn't changed since they were last copied, and records what was
 * copied in the clone's manifest.
 */
export async function copyTracks(
  sourceRoot: string,
  cloneRoot: string,
  paths: string[],
  onProgress: (message: string) => void,
): Promise<CopySummary> {
  const db = await readClone(cloneRoot);

  const plan = planTracks(sourceRoot, cloneRoot, paths);
  const synced = { ...db.synced };
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
  if (summary.copied > 0) await writeManifestAt(cloneRoot, { ...db, synced });
  return summary;
}

/** A file a push or pull left alone, without the time (the caller adds it). */
export type FoundConflict = Omit<Conflict, "when">;

export interface PushSummary {
  /** Files renamed into place inside the clone because they had moved in the library. */
  relinked: number;
  /** Files copied from the source into the clone. */
  copied: number;
  /** Files identical on both sides. */
  unchanged: number;
  /** Files changed on the clone since the last push, left alone. */
  cloneChanged: number;
  /** Files changed on both sides since the last push, left alone. */
  bothChanged: number;
  /** Which files those were. */
  conflicts: FoundConflict[];
  /** Files only the clone has; a pull can bring them in. */
  onlyClone: number;
  /** Crate members missing from both the source and the clone. */
  missing: number;
  /** Crate members outside the source library, left out of the crate files. */
  outside: number;
  /** Crate files written. */
  crates: number;
  /** Tracks added to the drive's Serato database because it didn't have them. */
  databaseAdded: number;
  /** Why the Serato database was left alone, or null when it was updated. */
  databaseError: string | null;
  /** When the push finished, ISO 8601. */
  finished: string;
}

/**
 * Makes the clone match the library: every crate member the clone lacks
 * or that changed at the source is copied in, then one Serato `.crate` file
 * per crate is written into the drive's `_Serato_/Subcrates` and the tracks
 * are added to its `database V2`. Members are listed where they live in the
 * clone, relative to the volume root as Serato expects, even when the file
 * is missing, since the crate is the truth. Finally the clone's manifest
 * takes the source's crates and revision, and records the push.
 */
export async function pushClone(
  source: Manifest,
  sourceRoot: string,
  cloneRoot: string,
  onProgress: (message: string) => void,
): Promise<PushSummary> {
  const db = await readClone(cloneRoot);
  if (db.libraryId && source.libraryId && db.libraryId !== source.libraryId) {
    throw new Error("That clone belongs to a different library.");
  }

  const jobs = planCrates(sourceRoot, cloneRoot, source.crates);
  const synced = { ...db.synced };
  const summary: PushSummary = {
    relinked: 0,
    copied: 0,
    unchanged: 0,
    cloneChanged: 0,
    bothChanged: 0,
    conflicts: [],
    onlyClone: 0,
    missing: 0,
    outside: 0,
    crates: 0,
    databaseAdded: 0,
    databaseError: null,
    finished: "",
  };

  // 1. Files. Each track once, even when several crates hold it.
  const tracks = uniqueTracks(jobs, (n) => (summary.outside += n));

  // Files the clone already holds, by name, so a track that moved in the
  // library is renamed to its new place rather than copied again. A file
  // that another member expects where it is, or whose twin still exists at
  // the source, belongs to that other track and stays put.
  onProgress("Looking for moved files in the clone…");
  const tracksRoot = `${normalizeRoot(cloneRoot)}/Tracks`;
  const cloneIndex = buildIndex((await scanLibrary(tracksRoot)).files);
  const expected = new Set(tracks.map((t) => encodePath(t.relative).toLowerCase()));
  const relinkInClone = async (track: TrackJob): Promise<boolean> => {
    const match = matchTrack(tracksRoot, track.clonePath, cloneIndex, null, expected);
    if (match.kind !== "moved") return false;
    const wasAt = decodePath(match.to);
    if (await exists(`${normalizeRoot(sourceRoot)}/${wasAt}`)) return false;
    try {
      await mkdir(parentOf(track.clonePath), { recursive: true });
      await rename(`${tracksRoot}/${match.to}`, track.clonePath);
    } catch {
      // Another track may have claimed the file first; a copy will follow.
      return false;
    }
    if (synced[wasAt] && !synced[track.relative]) synced[track.relative] = synced[wasAt];
    delete synced[wasAt];
    return true;
  };

  /** Tracks that exist in the clone after this pass, for the Serato database. */
  const present: TrackInfo[] = [];
  let started = 0;
  await forEachConcurrent(tracks, 4, async (track) => {
    started += 1;
    onProgress(
      `Checking ${started.toLocaleString()} / ${tracks.length.toLocaleString()}: ${fileName(track.source)}`,
    );
    if (await relinkInClone(track)) summary.relinked += 1;
    const [source, clone] = await Promise.all([
      fileState(track.source),
      fileState(track.clonePath),
    ]);
    const action = decidePush(synced[track.relative], source, clone);
    switch (action) {
      case "copy":
        synced[track.relative] = await copy(track.source, track.clonePath);
        summary.copied += 1;
        break;
      case "unchanged":
        synced[track.relative] = { source: source!, clone: clone! };
        summary.unchanged += 1;
        break;
      case "cloneChanged":
      case "bothChanged":
        summary[action] += 1;
        summary.conflicts.push({ path: track.relative, changed: action === "bothChanged" ? "both" : "clone" });
        break;
      case "onlyClone":
        summary.onlyClone += 1;
        break;
      case "missing":
        summary.missing += 1;
        return;
    }
    present.push({ path: volumeRelative(track.clonePath), ...(synced[track.relative]?.clone ?? clone!) });
  });

  // 2. Crate files.
  await mkdir(seratoSubcratesFolder(cloneRoot), { recursive: true });
  for (const job of jobs) {
    onProgress(`Writing crate: ${job.names.join(" / ")}`);
    const paths = job.tracks.map((t) => volumeRelative(t.clonePath));
    await writeFile(seratoCrateFile(cloneRoot, job.names), encodeCrate(newCrate(paths)));
    summary.crates += 1;
  }

  // 3. The drive's Serato database. A database that can't be read is left
  // alone rather than replaced: it is Serato's, and the crates work without it.
  onProgress("Updating the Serato database");
  try {
    summary.databaseAdded = await addToDatabase(cloneRoot, present);
  } catch (e) {
    summary.databaseError = e instanceof Error ? e.message : String(e);
  }

  summary.finished = new Date().toISOString();
  await writeManifestAt(cloneRoot, {
    ...db,
    libraryId: source.libraryId,
    revision: source.revision,
    crates: source.crates,
    tracks: source.tracks,
    synced,
    peers: {
      ...db.peers,
      [source.locationId]: {
        name: source.name,
        kind: "source",
        revision: source.revision,
        lastSync: summary.finished,
        path: normalizeRoot(sourceRoot),
      },
    },
  });
  return summary;
}

export interface PullPlan {
  /** Files the clone changed or added, to copy into the library. */
  copy: TrackJob[];
  /** Files changed on both sides since the last push, left for the user. */
  bothChanged: TrackJob[];
  unchanged: number;
  /** Crate members missing from both sides. */
  missing: number;
  /** Crate members outside the source library. */
  outside: number;
}

/** Works out what a pull from the clone would copy. Nothing is changed. */
export async function planPull(
  source: Manifest,
  sourceRoot: string,
  cloneRoot: string,
  onProgress: (message: string) => void,
): Promise<PullPlan> {
  const db = await readClone(cloneRoot);
  if (db.libraryId && source.libraryId && db.libraryId !== source.libraryId) {
    throw new Error("That clone belongs to a different library.");
  }
  const plan: PullPlan = { copy: [], bothChanged: [], unchanged: 0, missing: 0, outside: 0 };
  const tracks = uniqueTracks(planCrates(sourceRoot, cloneRoot, source.crates), (n) => (plan.outside += n));

  let started = 0;
  await forEachConcurrent(tracks, 4, async (track) => {
    started += 1;
    onProgress(
      `Comparing ${started.toLocaleString()} / ${tracks.length.toLocaleString()}: ${fileName(track.source)}`,
    );
    const [source, clone] = await Promise.all([
      fileState(track.source),
      fileState(track.clonePath),
    ]);
    switch (decidePull(db.synced[track.relative], source, clone)) {
      case "copy":
        plan.copy.push(track);
        break;
      case "bothChanged":
        plan.bothChanged.push(track);
        break;
      case "unchanged":
        plan.unchanged += 1;
        break;
      case "missing":
        plan.missing += 1;
        break;
    }
  });
  plan.copy.sort((a, b) => a.relative.localeCompare(b.relative));
  plan.bothChanged.sort((a, b) => a.relative.localeCompare(b.relative));
  return plan;
}

export interface PullSummary {
  /** Files copied from the clone into the library. */
  copied: number;
  /** Files changed on both sides, left alone. */
  bothChanged: number;
  conflicts: FoundConflict[];
  /** When the pull finished, ISO 8601. */
  finished: string;
}

/** Copies the files a pull plan lists into the library and records the copies. */
export async function applyPull(
  cloneRoot: string,
  plan: PullPlan,
  onProgress: (message: string) => void,
): Promise<PullSummary> {
  const db = await readClone(cloneRoot);
  const synced = { ...db.synced };
  const summary: PullSummary = {
    copied: 0,
    bothChanged: plan.bothChanged.length,
    conflicts: plan.bothChanged.map((t) => ({ path: t.relative, changed: "both" })),
    finished: "",
  };

  let started = 0;
  await forEachConcurrent(plan.copy, 4, async (track) => {
    started += 1;
    onProgress(
      `Bringing in ${started.toLocaleString()} / ${plan.copy.length.toLocaleString()}: ${fileName(track.source)}`,
    );
    synced[track.relative] = reversed(await copy(track.clonePath, track.source));
    summary.copied += 1;
  });

  summary.finished = new Date().toISOString();
  if (summary.copied > 0) await writeManifestAt(cloneRoot, { ...db, synced });
  return summary;
}

/** Each crate member once, however many crates hold it; `outside` reports members with no place in the clone. */
function uniqueTracks(jobs: ReturnType<typeof planCrates>, outside: (n: number) => void): TrackJob[] {
  const unique = new Map<string, TrackJob>();
  for (const job of jobs) {
    outside(job.outside.length);
    for (const track of job.tracks) {
      const key = track.relative.toLowerCase();
      if (!unique.has(key)) unique.set(key, track);
    }
  }
  return [...unique.values()];
}

/**
 * Adds the tracks to the drive's `database V2`, creating it if there is
 * none, and reports how many were new. Serato's own records are kept as
 * they are. The file is replaced in one step so a crash can't leave it half
 * written.
 */
async function addToDatabase(cloneRoot: string, tracks: TrackInfo[]): Promise<number> {
  const file = seratoDatabaseFile(cloneRoot);
  const existing = (await exists(file)) ? decodeDatabase(await readFile(file)) : newDatabase();
  const { database, added } = addTracks(existing, tracks, Date.now());
  if (added === 0) return 0;

  const temp = `${file}.clooner-tmp`;
  await writeFile(temp, encodeDatabase(database));
  await rename(temp, file);
  return added;
}

/** The clone's manifest, which must be there and be a clone's. */
async function readClone(cloneRoot: string): Promise<Manifest> {
  const db = await readManifestAt(cloneRoot);
  if (!db || db.kind !== "clone") throw new Error("That folder isn't an attached clone.");
  return db;
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
