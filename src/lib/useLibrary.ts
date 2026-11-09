// The app's persisted state and the actions that change it, as a hook.
//
// The database (where the source is, which clones are known, and a copy of
// the library manifest) is loaded once at startup and saved after every
// change. The manifest at the source root is the truth for the library:
// when the root is reachable, the copy here is read from it or written back
// to it; when the root is away, crate edits are kept here and written at the
// next chance. Alongside lives transient status that is never saved:
// whether the source has been scanned, whether each clone's folder is
// present, progress while folders are being created or a sync is running.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, message as showMessage } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { normalizeRoot } from "@/core/clone";
import { emptyDb, type AppDb, type CloneEntry, type SourceEntry } from "@/core/db";
import type { Unresolved } from "@/core/issues";
import { newSourceManifest, type Manifest } from "@/core/manifest";
import { baseName } from "@/core/paths";
import { buildIndex, movedPath, relinkTree, remapKeys, type RelinkPlan } from "@/core/relink";
import type { CrateTree } from "@/core/tree";
import {
  attachClone,
  pickFolder,
  readManifestAt,
  scanLibrary,
  writeManifestAt,
  type CloneResult,
  type ScanResult,
} from "@/lib/library";
import { loadDb, saveDb } from "@/lib/store";
import {
  applyPull,
  copyTracks,
  planPull,
  pushClone as runPush,
  type CopySummary,
  type PullSummary,
  type PushSummary,
} from "@/lib/sync";
import { allTrackPaths, describePullPlan, describeRelink } from "@/lib/utils";

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
  /** The last push (crate files written) in this session. */
  lastPush?: PushSummary;
  /** The last pull (clone changes brought in) in this session. */
  lastPull?: PullSummary;
  /** The last copy of dropped tracks in this session. */
  lastCopy?: CopySummary;
}

export type CloneStatus =
  /** The source isn't available, so the clone can't be checked yet. */
  | { kind: "waiting" }
  | { kind: "attaching"; progress: string }
  | ReadyStatus
  /** A copy, push or pull is running; `ready` is restored when it finishes. */
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
  /** True while an add, a push or a pull is in progress. */
  busy: boolean;
  source: SourceEntry | null;
  sourceStatus: SourceStatus | null;
  /** The library: its name, ids, revision and crates. Null until there are crates or a source. */
  library: Manifest | null;
  /** True while crate changes are waiting to be written to the source root. */
  dirty: boolean;
  /** Tracks the last scan couldn't find, keyed by track key. Empty until scanned. */
  unresolved: Unresolved;
  clones: CloneEntry[];
  cloneStatus: Record<string, CloneStatus>;
  crates: CrateTree;
  setCrates: (tree: CrateTree) => void;
  /** Known track lengths in seconds, keyed by track key. */
  durations: Record<string, number>;
  /** Records freshly read track lengths, keyed by track key. */
  setDurations: (updates: Record<string, number>) => void;
  /**
   * Picks a library root. A root that already holds a library opens it.
   * Otherwise, with a source already set, the crate members are matched by
   * file name against the new root and the user confirms the outcome before
   * anything changes. No track files are touched.
   */
  changeSource: () => Promise<void>;
  /** Picks a folder and makes it a clone, or re-attaches an existing one. */
  addClone: () => Promise<void>;
  /** Forgets a clone. Nothing on disk is touched. */
  removeClone: (path: string) => void;
  /**
   * Makes the clone match the library: copies new and changed files in and
   * writes its crates and Serato database. Nothing is copied back.
   */
  pushClone: (path: string) => Promise<void>;
  /** Pushes to every clone that is connected right now, one after another. */
  pushAll: () => Promise<void>;
  /**
   * Brings files the clone changed or added into the library, after the
   * user confirms the list. Files changed on both sides are left alone.
   */
  pullClone: (path: string) => Promise<void>;
  /** Pulls from every clone that is connected right now, one after another. */
  pullAll: () => Promise<void>;
  /**
   * Copies tracks (tree paths) into every connected clone, right away.
   * Resolves to how many clones received them and how many files were
   * actually copied.
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
  /**
   * True once the manifest at the source root has been read or written this
   * session and found to be ours, so later changes can go straight to it.
   */
  const rootWritable = useRef(false);

  const update = useCallback((fn: (db: AppDb) => AppDb) => {
    const next = fn(dbRef.current ?? emptyDb());
    dbRef.current = next;
    setDb(next);
    saveDb(next).catch((e) => setError(`Couldn't save the database: ${message(e)}`));
  }, []);

  /**
   * Writes the library to the source root when it has unwritten changes and
   * the root is known to be reachable and ours. Clears the dirty flag only
   * if nothing changed meanwhile; a later change triggers its own write.
   */
  const persistLibrary = useCallback(async () => {
    const current = dbRef.current;
    if (!current?.source || !current.library || !current.dirty || !rootWritable.current) return;
    const written = current.library;
    try {
      await writeManifestAt(current.source.path, written);
      update((d) =>
        d.library === written ? { ...d, dirty: false, baseRevision: written.revision } : d,
      );
    } catch (e) {
      setError(`Couldn't write the library to ${current.source.path}: ${message(e)}`);
    }
  }, [update]);

  /** Changes the library and schedules the write to the root. */
  const editLibrary = useCallback(
    (fn: (library: Manifest) => Manifest) => {
      update((d) => {
        const library = d.library ?? newSourceManifest(d.source ? baseName(d.source.path) : "");
        return { ...d, library: fn(library), dirty: true };
      });
      void persistLibrary();
    },
    [persistLibrary, update],
  );

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
      const crates = current.library?.crates ?? [];
      const plan = relinkTree(root, crates, buildIndex(scan.files), oldRoot);
      if (plan.moves.size > 0) {
        update((d) => applyPlan(d, plan));
        void persistLibrary();
      }
      return {
        moved: plan.moved,
        ambiguous: plan.ambiguous,
        notFound: plan.notFound,
        unresolved: plan.unresolved,
      };
    },
    [persistLibrary, update],
  );

  /**
   * Brings the copy here and the manifest at the root into line. A root
   * with no manifest gets the library written to it (the first write, or
   * an upgrade from a database that held the crates itself). Otherwise the
   * root's manifest is taken, unless changes were made here while the root
   * was away: then they are written if the root hasn't changed since, and
   * kept here with a warning if it has. Throws when the root holds a clone
   * or another library.
   */
  const adoptManifest = useCallback(
    async (root: string): Promise<Manifest> => {
      const found = await readManifestAt(root);
      const current = dbRef.current ?? emptyDb();
      const local = current.library;

      if (found === null) {
        const library = local ?? newSourceManifest(baseName(root));
        const named = library.name ? library : { ...library, name: baseName(root) };
        await writeManifestAt(root, named);
        update((d) => ({ ...d, library: named, dirty: false, baseRevision: named.revision }));
        rootWritable.current = true;
        return named;
      }
      if (found.kind !== "source") {
        throw new Error(`This folder is a clone ("${found.name}"), not a source library.`);
      }
      if (local && local.libraryId !== found.libraryId) {
        throw new Error(
          `This folder holds a different library ("${found.name}"). Use Change Source to open it.`,
        );
      }
      if (!local || !current.dirty) {
        update((d) => ({ ...d, library: found, dirty: false, baseRevision: found.revision }));
        rootWritable.current = true;
        return found;
      }
      if (found.revision === current.baseRevision) {
        // Only this computer changed anything: write the changes through.
        await writeManifestAt(root, local);
        update((d) => ({ ...d, dirty: false, baseRevision: local.revision }));
        rootWritable.current = true;
        return local;
      }
      rootWritable.current = false;
      setWarning(
        `Crates were changed here while the source was away, and the library at ${root} changed too (now revision ${found.revision}). Your changes are kept here and will not be written until merging arrives.`,
      );
      return local;
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
          rootWritable.current = false;
          setSourceStatus({ kind: "missing" });
          return null;
        }
        await adoptManifest(path);
        scan ??= await scanLibrary(path);
        const relink = applyRelink(path, scan, oldRoot);
        setSourceStatus({ kind: "ready", scan, relink });
        return scan;
      } catch (e) {
        rootWritable.current = false;
        setSourceStatus({ kind: "error", message: message(e) });
        return null;
      }
    },
    [adoptManifest, applyRelink],
  );

  /** Attaches one clone, reporting progress, and records its id. Throws on failure. */
  const attachOne = useCallback(
    async (source: Manifest, sourcePath: string, clone: CloneEntry, scan: ScanResult): Promise<CloneResult> => {
      setClone(clone.path, { kind: "attaching", progress: "Checking…" });
      const result = await attachClone(source, sourcePath, clone.path, scan, (done, total) => {
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
    async (source: Manifest, sourcePath: string, clone: CloneEntry, scan: ScanResult) => {
      try {
        if (!(await exists(clone.path))) {
          setClone(clone.path, { kind: "missing" });
          return;
        }
        await attachOne(source, sourcePath, clone, scan);
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
      const latest = dbRef.current ?? current;
      const library = latest.library;
      if (!library) return;
      await Promise.all(latest.clones.map((c) => refreshClone(library, sourcePath, c, scan)));
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

  /** Every crate change is a new revision of the library. */
  const setCrates = useCallback(
    (tree: CrateTree) => editLibrary((lib) => ({ ...lib, crates: tree, revision: lib.revision + 1 })),
    [editLibrary],
  );

  /** Track lengths are facts about files, not edits: they don't bump the revision. */
  const setDurations = useCallback(
    (updates: Record<string, number>) =>
      editLibrary((lib) => {
        const tracks = { ...lib.tracks };
        for (const [key, duration] of Object.entries(updates)) {
          tracks[key] = { ...tracks[key], duration };
        }
        return { ...lib, tracks };
      }),
    [editLibrary],
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

      let found: Manifest | null;
      try {
        found = await readManifestAt(path);
      } catch (e) {
        setError(`Couldn't read ${path}: ${message(e)}`);
        return;
      }
      if (found?.kind === "clone") {
        setError(`That folder is a clone ("${found.name}"), not a source library.`);
        return;
      }
      const local = current.library;
      const added = new Date().toISOString();

      // A root that already holds a library: open it. The crates here, if
      // they are another library's, stay in that library's own folder.
      if (found && (!local || found.libraryId !== local.libraryId)) {
        if (local && local.crates.length > 0) {
          const ok = await confirm(
            `${path}\nalready holds the library "${found.name}" (revision ${found.revision}).\n\nOpen it? The crates shown now ("${local.name || "unnamed"}") stay in their own folder and will no longer be shown here.`,
            { title: "Open library", kind: "info", okLabel: "Open it", cancelLabel: "Keep current" },
          );
          if (!ok) return;
        }
        update((d) => ({
          ...d,
          source: { path, added },
          library: found,
          dirty: false,
          baseRevision: found.revision,
        }));
        await refreshAll(dbRef.current!);
        return;
      }

      // The same library at a new root (moved, or restored from a backup):
      // its manifest already speaks for the new place.
      if (found) {
        update((d) => ({ ...d, source: { path, added } }));
        await refreshAll(dbRef.current!);
        return;
      }

      // No library there yet: carry the crates over. With tracks to carry,
      // show where they will end up and let the user back out first.
      let scan: ScanResult | undefined;
      if (previous && local && allTrackPaths(local.crates).length > 0) {
        setSourceStatus({ kind: "scanning" });
        try {
          scan = await scanLibrary(path);
        } catch (e) {
          setError(`Couldn't read ${path}: ${message(e)}`);
          await refreshAll(current);
          return;
        }
        const plan = relinkTree(path, local.crates, buildIndex(scan.files), previous);
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

      update((d) => ({ ...d, source: { path, added } }));
      await refreshAll(dbRef.current!, scan, previous);
    } finally {
      setBusy(false);
    }
  }, [refreshAll, update]);

  const addClone = useCallback(async () => {
    const current = dbRef.current;
    if (!current?.source || !current.library || sourceStatus?.kind !== "ready") return;
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
      await attachOne(current.library, current.source.path, clone, sourceStatus.scan);
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

  const pushClone = useCallback(
    async (path: string) => {
      const current = dbRef.current;
      const status = cloneStatusRef.current[path];
      if (!current?.source || !current.library || status?.kind !== "ready") return;

      setError(null);
      setBusy(true);
      setClone(path, { kind: "working", progress: "Starting…", ready: status });
      try {
        const lastPush = await runPush(current.library, current.source.path, path, (progress) =>
          setClone(path, { kind: "working", progress, ready: status }),
        );
        setClone(path, { ...status, lastPush });
        update((d) => ({
          ...d,
          clones: d.clones.map((c) =>
            c.path === path
              ? {
                  ...c,
                  lastSync: lastPush.finished,
                  conflicts: lastPush.conflicts.map((k) => ({ ...k, when: lastPush.finished })),
                }
              : c,
          ),
        }));
      } catch (e) {
        setClone(path, status);
        setError(`Push failed: ${message(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [setClone, update],
  );

  const pullClone = useCallback(
    async (path: string) => {
      const current = dbRef.current;
      const status = cloneStatusRef.current[path];
      if (!current?.source || !current.library || status?.kind !== "ready") return;

      setError(null);
      setBusy(true);
      setClone(path, { kind: "working", progress: "Comparing…", ready: status });
      try {
        const plan = await planPull(current.library, current.source.path, path, (progress) =>
          setClone(path, { kind: "working", progress, ready: status }),
        );
        const name = status.result.name || path;
        setClone(path, status);
        if (plan.copy.length === 0 && plan.bothChanged.length === 0) {
          await showMessage(`Nothing to bring in from "${name}": every file matches the library.`, {
            title: "Pull",
            kind: "info",
          });
          return;
        }
        if (plan.copy.length === 0) {
          // Only files changed on both sides: nothing to do but say so.
          await showMessage(describePullPlan(plan, name), { title: "Pull", kind: "warning" });
          return;
        }
        const ok = await confirm(describePullPlan(plan, name), {
          title: "Pull",
          kind: plan.bothChanged.length > 0 ? "warning" : "info",
          okLabel: `Bring in ${plan.copy.length.toLocaleString()}`,
          cancelLabel: "Not now",
        });
        if (!ok) return;
        setClone(path, { kind: "working", progress: "Bringing in…", ready: status });
        const lastPull = await applyPull(path, plan, (progress) =>
          setClone(path, { kind: "working", progress, ready: status }),
        );
        setClone(path, { ...status, lastPull });
        update((d) => ({
          ...d,
          clones: d.clones.map((c) =>
            c.path === path
              ? { ...c, conflicts: lastPull.conflicts.map((k) => ({ ...k, when: lastPull.finished })) }
              : c,
          ),
        }));
      } catch (e) {
        setClone(path, status);
        setError(`Pull failed: ${message(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [setClone, update],
  );

  /** One clone at a time: two jobs at once would only fight over the disk. */
  const forEachConnected = useCallback(async (job: (path: string) => Promise<void>) => {
    const current = dbRef.current;
    if (!current?.source) return;
    for (const clone of current.clones) {
      if (cloneStatusRef.current[clone.path]?.kind === "ready") await job(clone.path);
    }
  }, []);

  const pushAll = useCallback(() => forEachConnected(pushClone), [forEachConnected, pushClone]);
  const pullAll = useCallback(() => forEachConnected(pullClone), [forEachConnected, pullClone]);

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

  const rescan = useCallback(async () => {
    if (dbRef.current) await refreshAll(dbRef.current);
  }, [refreshAll]);

  const unresolved = sourceStatus?.kind === "ready" ? sourceStatus.relink.unresolved : EMPTY_UNRESOLVED;

  const tracks = db?.library?.tracks;
  const durations = useMemo(() => {
    if (!tracks) return EMPTY_DURATIONS;
    const out: Record<string, number> = {};
    for (const [key, entry] of Object.entries(tracks)) {
      if (entry.duration !== undefined) out[key] = entry.duration;
    }
    return out;
  }, [tracks]);

  return {
    loading: db === null,
    warning,
    error,
    busy,
    source: db?.source ?? null,
    sourceStatus,
    library: db?.library ?? null,
    dirty: db?.dirty ?? false,
    unresolved,
    clones: db?.clones ?? [],
    cloneStatus,
    crates: db?.library?.crates ?? EMPTY_CRATES,
    setCrates,
    durations,
    setDurations,
    changeSource,
    addClone,
    removeClone,
    pushClone,
    pushAll,
    pullClone,
    pullAll,
    copyToClones,
    rescan,
  };
}

/** Stable empty values, so consumers don't see a new object every render. */
const EMPTY_DURATIONS: Record<string, number> = {};
const EMPTY_UNRESOLVED: Unresolved = new Map();
const EMPTY_CRATES: CrateTree = [];

function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a).toLowerCase() === normalizeRoot(b).toLowerCase();
}

/**
 * The database with a relink plan's moves written through every place a
 * path is kept. Rewritten paths are a change to the library, so clones
 * pick them up: the revision moves on.
 */
function applyPlan(db: AppDb, plan: RelinkPlan): AppDb {
  const library = db.library ?? newSourceManifest("");
  return {
    ...db,
    library: {
      ...library,
      crates: plan.tree,
      tracks: remapKeys(library.tracks, plan.moves),
      revision: library.revision + 1,
    },
    dirty: true,
    clones: db.clones.map((c) => ({
      ...c,
      conflicts: c.conflicts.map((k) => ({ ...k, path: movedPath(k.path, plan.moves) })),
    })),
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
