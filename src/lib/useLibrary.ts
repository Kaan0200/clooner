// The app's persisted state and the actions that change it, as a hook.
//
// The database (source, clones, crates) is loaded once at startup and saved
// after every change. Alongside it lives transient status that is never
// saved: whether the source has been scanned, whether each clone's folder is
// present, progress while folders are being created or a sync is running.

import { useCallback, useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { normalizeRoot } from "@/core/clone";
import { emptyDb, type AppDb, type CloneEntry, type SourceEntry } from "@/core/db";
import type { Unresolved } from "@/core/issues";
import { buildIndex, movedPath, relinkTree, remapDurations, type RelinkPlan } from "@/core/relink";
import type { CrateTree } from "@/core/tree";
import {
  attachClone,
  pickFolder,
  scanLibrary,
  type CloneResult,
  type ScanResult,
} from "@/lib/library";
import { loadDb, saveDb } from "@/lib/store";
import { copyTracks, syncClone as runSync, type CopySummary, type SyncSummary } from "@/lib/sync";
import { allTrackPaths, describeRelink } from "@/lib/utils";

/** How the crate members fared against the last scan of the source. */
export interface RelinkSummary {
  /** Tracks whose paths were rewritten because their files had moved. */
  moved: number;
  ambiguous: number;
  notFound: number;
  /** The ambiguous and not-found tracks, for the dots on their rows. */
  unresolved: Unresolved;
}

export type SourceStatus =
  | { kind: "scanning" }
  | { kind: "ready"; scan: ScanResult; relink: RelinkSummary }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export interface ReadyStatus {
  kind: "ready";
  result: CloneResult;
  /** The last sync (crate files written) in this session. */
  lastSync?: SyncSummary;
  /** The last copy of dropped tracks in this session. */
  lastCopy?: CopySummary;
}

export type CloneStatus =
  /** The source isn't available, so the clone can't be checked yet. */
  | { kind: "waiting" }
  | { kind: "attaching"; progress: string }
  | ReadyStatus
  /** A copy or a sync is running; `ready` is restored when it finishes. */
  | { kind: "working"; progress: string; ready: ReadyStatus }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export interface Library {
  /** True until the database has been read. */
  loading: boolean;
  /** A startup problem worth showing, such as a damaged database set aside. */
  warning: string | null;
  /** The last action that failed. */
  error: string | null;
  /** True while an add or a sync is in progress. */
  busy: boolean;
  source: SourceEntry | null;
  sourceStatus: SourceStatus | null;
  /** Tracks the last scan couldn't find, keyed by track key. Empty until scanned. */
  unresolved: Unresolved;
  clones: CloneEntry[];
  cloneStatus: Record<string, CloneStatus>;
  crates: CrateTree;
  setCrates: (tree: CrateTree) => void;
  /** Known track lengths in seconds, keyed as in core/duration.ts. */
  durations: Record<string, number>;
  /** Records freshly read track lengths. */
  setDurations: (updates: Record<string, number>) => void;
  /**
   * Picks a library root. With a source already set, the crate members are
   * matched by file name against the new root and the user confirms the
   * outcome before anything changes. Nothing on disk is touched.
   */
  changeSource: () => Promise<void>;
  /** Picks a folder and makes it a clone, or re-attaches an existing one. */
  addClone: () => Promise<void>;
  /** Forgets a clone. Nothing on disk is touched. */
  removeClone: (path: string) => void;
  /** Writes the current crate contents as Serato crate files into the clone. */
  syncClone: (path: string) => Promise<void>;
  /** Syncs every clone that is connected right now, one after another. */
  syncAll: () => Promise<void>;
  /**
   * Copies tracks into every connected clone, right away. Resolves to how
   * many clones received them and how many files were actually copied.
   */
  copyToClones: (paths: string[]) => Promise<{ clones: number; copied: number }>;
  /** Rescans the source and re-attaches every clone. */
  rescan: () => Promise<void>;
}

export function useLibrary(): Library {
  const [db, setDb] = useState<AppDb | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);
  const [cloneStatus, setCloneStatus] = useState<Record<string, CloneStatus>>({});

  // Actions read the newest database and statuses through refs so that two
  // changes in the same tick never clobber each other.
  const dbRef = useRef<AppDb | null>(null);
  const cloneStatusRef = useRef(cloneStatus);
  cloneStatusRef.current = cloneStatus;

  const update = useCallback((fn: (db: AppDb) => AppDb) => {
    const next = fn(dbRef.current ?? emptyDb());
    dbRef.current = next;
    setDb(next);
    saveDb(next).catch((e) => setError(`Couldn't save the database: ${message(e)}`));
  }, []);

  const setClone = useCallback((path: string, status: CloneStatus | null) => {
    setCloneStatus((prev) => {
      const next = { ...prev };
      if (status) next[path] = status;
      else delete next[path];
      return next;
    });
  }, []);

  /**
   * Matches every crate member against a scan of the source and rewrites
   * the paths of those whose files moved, carrying their lengths and
   * conflict notes along. `oldRoot` is where the library was, when it has
   * just moved, to break ties by relative place.
   */
  const applyRelink = useCallback(
    (root: string, scan: ScanResult, oldRoot: string | null): RelinkSummary => {
      const current = dbRef.current ?? emptyDb();
      const plan = relinkTree(root, current.crates, buildIndex(scan.files), oldRoot);
      if (plan.moves.size > 0) update((d) => applyPlan(d, plan));
      return {
        moved: plan.moved,
        ambiguous: plan.ambiguous,
        notFound: plan.notFound,
        unresolved: plan.unresolved,
      };
    },
    [update],
  );

  /**
   * Scans the source (or takes a scan already made) and records the
   * outcome, relinking moved tracks. Resolves to the scan when usable.
   */
  const refreshSource = useCallback(
    async (path: string, scan?: ScanResult, oldRoot: string | null = null): Promise<ScanResult | null> => {
      setSourceStatus({ kind: "scanning" });
      try {
        if (!(await exists(path))) {
          setSourceStatus({ kind: "missing" });
          return null;
        }
        scan ??= await scanLibrary(path);
        const relink = applyRelink(path, scan, oldRoot);
        setSourceStatus({ kind: "ready", scan, relink });
        return scan;
      } catch (e) {
        setSourceStatus({ kind: "error", message: message(e) });
        return null;
      }
    },
    [applyRelink],
  );

  /** Attaches one clone, reporting progress, and records its id. Throws on failure. */
  const attachOne = useCallback(
    async (sourcePath: string, clone: CloneEntry, scan: ScanResult): Promise<CloneResult> => {
      setClone(clone.path, { kind: "attaching", progress: "Checking…" });
      const result = await attachClone(sourcePath, clone.path, scan, (done, total) => {
        const progress = `Creating folders… ${done.toLocaleString()} / ${total.toLocaleString()}`;
        setClone(clone.path, { kind: "attaching", progress });
      });
      setClone(clone.path, { kind: "ready", result });
      if (clone.id !== result.id) {
        update((d) => ({
          ...d,
          clones: d.clones.map((c) => (c.path === clone.path ? { ...c, id: result.id } : c)),
        }));
      }
      return result;
    },
    [setClone, update],
  );

  /** Re-attaches a known clone, turning failures into status rather than errors. */
  const refreshClone = useCallback(
    async (sourcePath: string, clone: CloneEntry, scan: ScanResult) => {
      try {
        if (!(await exists(clone.path))) {
          setClone(clone.path, { kind: "missing" });
          return;
        }
        await attachOne(sourcePath, clone, scan);
      } catch (e) {
        setClone(clone.path, { kind: "error", message: message(e) });
      }
    },
    [attachOne, setClone],
  );

  const refreshAll = useCallback(
    async (current: AppDb, scan?: ScanResult, oldRoot: string | null = null) => {
      if (!current.source) {
        setSourceStatus(null);
        setCloneStatus({});
        return;
      }
      setCloneStatus(Object.fromEntries(current.clones.map((c) => [c.path, { kind: "waiting" }])));
      scan = (await refreshSource(current.source.path, scan, oldRoot)) ?? undefined;
      if (!scan) return;
      const sourcePath = current.source.path;
      await Promise.all(current.clones.map((c) => refreshClone(sourcePath, c, scan)));
    },
    [refreshClone, refreshSource],
  );

  useEffect(() => {
    let cancelled = false;
    loadDb()
      .then((loaded) => {
        if (cancelled) return;
        dbRef.current = loaded.db;
        setDb(loaded.db);
        setWarning(loaded.warning);
        void refreshAll(loaded.db);
      })
      .catch((e) => {
        if (cancelled) return;
        dbRef.current = emptyDb();
        setDb(dbRef.current);
        setWarning(`Couldn't read the database: ${message(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshAll]);

  const setCrates = useCallback(
    (tree: CrateTree) => update((d) => ({ ...d, crates: tree })),
    [update],
  );

  const changeSource = useCallback(async () => {
    setError(null);
    const current = dbRef.current ?? emptyDb();
    const previous = current.source?.path ?? null;
    const path = await pickFolder(
      previous ? "Choose the new root folder of your music library" : "Choose the root folder of your music library",
    );
    if (!path) return;

    setBusy(true);
    try {
      // The same folder again is just a rescan.
      if (previous && sameRoot(previous, path)) {
        await refreshAll(current);
        return;
      }

      // With crates to carry over, show where their tracks will end up and
      // let the user back out before anything is written.
      let scan: ScanResult | undefined;
      if (previous && allTrackPaths(current.crates).length > 0) {
        setSourceStatus({ kind: "scanning" });
        try {
          scan = await scanLibrary(path);
        } catch (e) {
          setError(`Couldn't read ${path}: ${message(e)}`);
          await refreshAll(current);
          return;
        }
        const plan = relinkTree(path, current.crates, buildIndex(scan.files), previous);
        const ok = await confirm(describeRelink(previous, path, plan), {
          title: "Change source",
          kind: plan.ambiguous + plan.notFound > 0 ? "warning" : "info",
          okLabel: "Change source",
          cancelLabel: "Keep current",
        });
        if (!ok) {
          await refreshAll(current);
          return;
        }
      }

      update((d) => ({ ...d, source: { path, added: new Date().toISOString() } }));
      await refreshAll(dbRef.current!, scan, previous);
    } finally {
      setBusy(false);
    }
  }, [refreshAll, update]);

  const addClone = useCallback(async () => {
    const current = dbRef.current;
    if (!current?.source || sourceStatus?.kind !== "ready") return;
    setError(null);
    const path = await pickFolder("Choose a folder for the clone (empty, or an existing clone)");
    if (!path) return;
    if (current.clones.some((c) => c.path === path)) {
      setError("That clone is already in the list.");
      return;
    }

    const clone: CloneEntry = {
      path,
      id: null,
      added: new Date().toISOString(),
      lastSync: null,
      conflicts: [],
    };
    setBusy(true);
    update((d) => ({ ...d, clones: [...d.clones, clone] }));
    try {
      await attachOne(current.source.path, clone, sourceStatus.scan);
    } catch (e) {
      // A folder that can't be a clone shouldn't stay in the list.
      update((d) => ({ ...d, clones: d.clones.filter((c) => c.path !== path) }));
      setClone(path, null);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [attachOne, setClone, sourceStatus, update]);

  const removeClone = useCallback(
    (path: string) => {
      update((d) => ({ ...d, clones: d.clones.filter((c) => c.path !== path) }));
      setClone(path, null);
    },
    [setClone, update],
  );

  const syncClone = useCallback(
    async (path: string) => {
      const current = dbRef.current;
      const status = cloneStatusRef.current[path];
      if (!current?.source || status?.kind !== "ready") return;

      setError(null);
      setBusy(true);
      setClone(path, { kind: "working", progress: "Starting…", ready: status });
      try {
        const lastSync = await runSync(current.source.path, path, current.crates, (progress) =>
          setClone(path, { kind: "working", progress, ready: status }),
        );
        setClone(path, { ...status, lastSync });
        update((d) => ({
          ...d,
          clones: d.clones.map((c) =>
            c.path === path
              ? {
                  ...c,
                  lastSync: lastSync.finished,
                  conflicts: lastSync.conflicts.map((k) => ({ ...k, when: lastSync.finished })),
                }
              : c,
          ),
        }));
      } catch (e) {
        setClone(path, status);
        setError(`Sync failed: ${message(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [setClone, update],
  );

  const syncAll = useCallback(async () => {
    const current = dbRef.current;
    if (!current?.source) return;
    // One at a time: each sync reads the source and writes the clone, and
    // two running at once would only fight over the disk.
    for (const clone of current.clones) {
      if (cloneStatusRef.current[clone.path]?.kind === "ready") {
        await syncClone(clone.path);
      }
    }
  }, [syncClone]);

  const copyToClones = useCallback(
    async (paths: string[]) => {
      const current = dbRef.current;
      const totals = { clones: 0, copied: 0 };
      if (!current?.source || paths.length === 0) return totals;
      const sourcePath = current.source.path;

      // Only clones that are attached right now can receive files.
      const targets = current.clones.flatMap((c) => {
        const status = cloneStatusRef.current[c.path];
        return status?.kind === "ready" ? [{ path: c.path, status }] : [];
      });
      if (targets.length === 0) return totals;

      setBusy(true);
      try {
        await Promise.all(
          targets.map(async ({ path, status }) => {
            setClone(path, { kind: "working", progress: "Copying…", ready: status });
            try {
              const lastCopy = await copyTracks(sourcePath, path, paths, (progress) =>
                setClone(path, { kind: "working", progress, ready: status }),
              );
              setClone(path, { ...status, lastCopy });
              totals.clones += 1;
              totals.copied += lastCopy.copied;
            } catch (e) {
              setClone(path, status);
              setError(`Couldn't copy to ${path}: ${message(e)}`);
            }
          }),
        );
      } finally {
        setBusy(false);
      }
      return totals;
    },
    [setClone],
  );

  const setDurations = useCallback(
    (updates: Record<string, number>) =>
      update((d) => ({ ...d, durations: { ...d.durations, ...updates } })),
    [update],
  );

  const rescan = useCallback(async () => {
    if (dbRef.current) await refreshAll(dbRef.current);
  }, [refreshAll]);

  const unresolved = sourceStatus?.kind === "ready" ? sourceStatus.relink.unresolved : EMPTY_UNRESOLVED;

  return {
    loading: db === null,
    warning,
    error,
    busy,
    source: db?.source ?? null,
    sourceStatus,
    unresolved,
    clones: db?.clones ?? [],
    cloneStatus,
    crates: db?.crates ?? [],
    setCrates,
    durations: db?.durations ?? EMPTY_DURATIONS,
    setDurations,
    changeSource,
    addClone,
    removeClone,
    syncClone,
    syncAll,
    copyToClones,
    rescan,
  };
}

/** Stable empty values, so consumers don't see a new object every render. */
const EMPTY_DURATIONS: Record<string, number> = {};
const EMPTY_UNRESOLVED: Unresolved = new Map();

function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a).toLowerCase() === normalizeRoot(b).toLowerCase();
}

/** The database with a relink plan's moves written through every place a path is kept. */
function applyPlan(db: AppDb, plan: RelinkPlan): AppDb {
  return {
    ...db,
    crates: plan.tree,
    durations: remapDurations(db.durations, plan.moves),
    clones: db.clones.map((c) => ({
      ...c,
      conflicts: c.conflicts.map((k) => ({ ...k, path: movedPath(k.path, plan.moves) })),
    })),
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
