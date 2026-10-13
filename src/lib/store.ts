// Where the application database lives and how it gets there safely.
//
// The file sits in the app's data folder (on Windows, `%APPDATA%/dev.clooner.app`).
// Saves go to a temporary file first and are then renamed into place, so a
// crash mid-write leaves the previous database intact rather than a half
// file. Saves are also coalesced: a burst of changes writes once, with the
// newest state.

import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { emptyDb, parseDb, serializeDb, type AppDb } from "@/core/db";

const FILE_NAME = "clooner.json";

let cachedDir: Promise<string> | null = null;

async function dataDir(): Promise<string> {
  cachedDir ??= appDataDir();
  return cachedDir;
}

/** The absolute path of the database file. */
export async function dbPath(): Promise<string> {
  return join(await dataDir(), FILE_NAME);
}

export interface LoadResult {
  db: AppDb;
  /** Set when a damaged database was moved aside and an empty one is in use. */
  warning: string | null;
}

/**
 * Loads the database, or an empty one when none has been saved yet. A file
 * that can't be read is renamed out of the way (so nothing is lost) and
 * reported in `warning`.
 */
export async function loadDb(): Promise<LoadResult> {
  const path = await dbPath();
  if (!(await exists(path))) return { db: emptyDb(), warning: null };

  const text = await readTextFile(path);
  try {
    return { db: parseDb(text), warning: null };
  } catch (e) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = await join(await dataDir(), `clooner.broken-${stamp}.json`);
    await rename(path, aside);
    const reason = e instanceof Error ? e.message : String(e);
    return {
      db: emptyDb(),
      warning: `${reason} The old file was kept as ${aside} and a fresh database started.`,
    };
  }
}

let newest: AppDb | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Saves the database. Calls made while a save is running are folded into
 * one more write of whatever state is newest when it starts.
 */
export function saveDb(db: AppDb): Promise<void> {
  newest = db;
  inFlight ??= flush();
  return inFlight;
}

async function flush(): Promise<void> {
  try {
    while (newest) {
      const db = newest;
      newest = null;
      await write(db);
    }
  } finally {
    inFlight = null;
  }
}

async function write(db: AppDb): Promise<void> {
  const dir = await dataDir();
  const path = await join(dir, FILE_NAME);
  const temp = await join(dir, `${FILE_NAME}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeTextFile(temp, serializeDb(db));
  await rename(temp, path);
}
