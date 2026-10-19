// Where the application database lives and how files get written safely.
//
// The database sits in the app's data folder (on Windows,
// `%APPDATA%/dev.clooner.app`). Every file this module writes, the database
// and the manifests at location roots alike, goes to a temporary file first
// and is then renamed into place, so a crash mid-write leaves the previous
// file intact rather than a half one. Writes are also coalesced per file: a
// burst of changes writes once, with the newest text.

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

/** Saves the database. Bursts of calls are folded into one write of the newest state. */
export async function saveDb(db: AppDb): Promise<void> {
  const dir = await dataDir();
  await mkdir(dir, { recursive: true });
  await writeTextAtomic(await join(dir, FILE_NAME), serializeDb(db));
}

interface Queue {
  newest: string | null;
  inFlight: Promise<void> | null;
}

const queues = new Map<string, Queue>();

/**
 * Writes `text` to `path` through a temporary file and a rename. Calls for
 * the same path made while a write is running are folded into one more
 * write of whatever text is newest when it starts.
 */
export function writeTextAtomic(path: string, text: string): Promise<void> {
  let queue = queues.get(path);
  if (!queue) {
    queue = { newest: null, inFlight: null };
    queues.set(path, queue);
  }
  queue.newest = text;
  queue.inFlight ??= flush(path, queue);
  return queue.inFlight;
}

async function flush(path: string, queue: Queue): Promise<void> {
  try {
    while (queue.newest !== null) {
      const text = queue.newest;
      queue.newest = null;
      const temp = `${path}.tmp`;
      await writeTextFile(temp, text);
      await rename(temp, path);
    }
  } finally {
    queue.inFlight = null;
    queues.delete(path);
  }
}
