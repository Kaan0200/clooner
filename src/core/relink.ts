// Finding crate members again after files have moved.
//
// A track's identity is its file name. When a member isn't where its path
// says, the library is searched for a file with the same name (ignoring
// case and extension). One hit means the track moved and the path is
// rewritten; several hits are narrowed by where the file used to be, and
// anything still ambiguous or absent is reported so the user can decide.
// Nothing here touches the disk: the caller supplies an index of the files
// it found and gets back a rewritten tree plus the counts.

import { isInside, normalizeRoot } from "./clone";
import { durationKey } from "./duration";
import { titleOf } from "./m3u";
import { trackKey, type CrateNode, type CrateTree } from "./tree";

/** The files under a root, ready to be searched by name or by path. */
export interface FileIndex {
  /** Lower-cased relative paths, "/"-separated. */
  paths: Set<string>;
  /** Relative paths grouped by lower-cased title (file name without extension). */
  byTitle: Map<string, string[]>;
}

/** Indexes relative paths ("/"-separated, no leading slash). */
export function buildIndex(relativeFiles: string[]): FileIndex {
  const paths = new Set<string>();
  const byTitle = new Map<string, string[]>();
  for (const file of relativeFiles) {
    const lower = file.toLowerCase();
    if (paths.has(lower)) continue;
    paths.add(lower);
    const title = titleOf(file).toLowerCase();
    const group = byTitle.get(title);
    if (group) group.push(file);
    else byTitle.set(title, [file]);
  }
  return { paths, byTitle };
}

export type Match =
  /** The file is where the path says. */
  | { kind: "kept" }
  /** Exactly one file with this name was found; `to` is its new absolute path. */
  | { kind: "moved"; to: string }
  /** Several files with this name; none could be singled out. Absolute paths. */
  | { kind: "ambiguous"; candidates: string[] }
  /** No file with this name under the root. */
  | { kind: "notFound" };

/**
 * Where a track is under `root` now. `oldRoot` is the root the path was
 * recorded against, when the library has moved; it lets a track keep its
 * relative place when several files share a name. `claimed` holds the
 * lower-cased relative paths of files that belong to other tracks, which
 * are never offered as a match.
 */
export function matchTrack(
  root: string,
  path: string,
  index: FileIndex,
  oldRoot: string | null = null,
  claimed: ReadonlySet<string> = EMPTY,
): Match {
  const normalRoot = normalizeRoot(root);
  const normalPath = normalizeRoot(path);
  const relative = relativeTo(normalRoot, normalPath);
  if (relative !== null && index.paths.has(relative.toLowerCase())) return { kind: "kept" };

  let candidates = (index.byTitle.get(titleOf(normalPath).toLowerCase()) ?? []).filter(
    (c) => !claimed.has(c.toLowerCase()),
  );
  if (candidates.length === 0) return { kind: "notFound" };

  // Narrow a tie, but never to nothing: the same relative place first,
  // then the same extension, then the same parent folder name.
  const wasAt = relative ?? (oldRoot ? relativeTo(normalizeRoot(oldRoot), normalPath) : null);
  if (wasAt) candidates = narrow(candidates, (c) => c.toLowerCase() === wasAt.toLowerCase());
  candidates = narrow(candidates, (c) => extensionOf(c) === extensionOf(normalPath));
  candidates = narrow(candidates, (c) => parentName(c) === parentName(normalPath));

  const absolute = candidates.map((c) => `${normalRoot}/${c}`);
  if (absolute.length === 1) return { kind: "moved", to: absolute[0] };
  return { kind: "ambiguous", candidates: absolute };
}

const EMPTY: ReadonlySet<string> = new Set();

function narrow(candidates: string[], keep: (c: string) => boolean): string[] {
  const kept = candidates.filter(keep);
  return kept.length > 0 ? kept : candidates;
}

/** `path` relative to `root` (both normalized), or null when it isn't inside. */
function relativeTo(root: string, path: string): string | null {
  if (!isInside(root, path) || path.length === root.length) return null;
  return path.slice(root.length + 1);
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function parentName(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "";
  const parent = path.slice(0, slash);
  return parent.slice(parent.lastIndexOf("/") + 1).toLowerCase();
}

export interface RelinkPlan {
  /** The tree with every moved track's path rewritten. */
  tree: CrateTree;
  kept: number;
  moved: number;
  ambiguous: number;
  notFound: number;
  /** Old path to new path for every moved track, keyed by the old track key. */
  moves: Map<string, string>;
  /** Tracks that couldn't be placed, keyed by track key. */
  unresolved: Map<string, Extract<Match, { kind: "ambiguous" | "notFound" }>>;
}

/**
 * Matches every member of every crate against the files under `root` and
 * rewrites the paths of those that moved. A track in several crates is
 * matched once. Counts are per distinct track. A file that is already a
 * member where it stands belongs to that member: a missing track with the
 * same name is never relinked onto it, since the two were different tracks.
 */
export function relinkTree(
  root: string,
  tree: CrateTree,
  index: FileIndex,
  oldRoot: string | null = null,
): RelinkPlan {
  const plan: RelinkPlan = {
    tree,
    kept: 0,
    moved: 0,
    ambiguous: 0,
    notFound: 0,
    moves: new Map(),
    unresolved: new Map(),
  };
  // First pass: which files are spoken for by a member that is in place.
  const normalRoot = normalizeRoot(root);
  const claimed = new Set<string>();
  const claim = (nodes: CrateNode[]) => {
    for (const node of nodes) {
      for (const path of node.tracks) {
        const relative = relativeTo(normalRoot, normalizeRoot(path));
        if (relative !== null && index.paths.has(relative.toLowerCase())) claimed.add(relative.toLowerCase());
      }
      claim(node.children);
    }
  };
  claim(tree);

  const decided = new Map<string, Match>();
  const decide = (path: string): Match => {
    const key = trackKey(path);
    let match = decided.get(key);
    if (match) return match;
    match = matchTrack(root, path, index, oldRoot, claimed);
    decided.set(key, match);
    switch (match.kind) {
      case "kept":
        plan.kept += 1;
        break;
      case "moved":
        plan.moved += 1;
        plan.moves.set(key, match.to);
        break;
      case "ambiguous":
        plan.ambiguous += 1;
        plan.unresolved.set(key, match);
        break;
      case "notFound":
        plan.notFound += 1;
        plan.unresolved.set(key, match);
        break;
    }
    return match;
  };

  // Untouched nodes and lists are returned as they are, so a pass that
  // moves nothing yields the very same tree and the caller can tell.
  const walk = (nodes: CrateNode[]): CrateNode[] => {
    const out = nodes.map((node) => {
      let changed = false;
      const tracks = node.tracks.map((path) => {
        const match = decide(path);
        if (match.kind !== "moved") return path;
        changed = true;
        return match.to;
      });
      const children = walk(node.children);
      return changed || children !== node.children ? { ...node, tracks, children } : node;
    });
    return out.every((node, i) => node === nodes[i]) ? nodes : out;
  };
  plan.tree = walk(tree);
  return plan;
}

/** Carries saved track lengths over to the moved tracks' new paths. */
export function remapDurations(
  durations: Record<string, number>,
  moves: Map<string, string>,
): Record<string, number> {
  if (moves.size === 0) return durations;
  const out = { ...durations };
  for (const [from, to] of moves) {
    const seconds = durations[durationKey(from)];
    if (seconds === undefined) continue;
    delete out[durationKey(from)];
    out[durationKey(to)] = seconds;
  }
  return out;
}

/** The moved path for a track, or the path itself when it didn't move. */
export function movedPath(path: string, moves: Map<string, string>): string {
  return moves.get(trackKey(path)) ?? path;
}
