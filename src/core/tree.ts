// The crate tree: collections (top-level crates) and their subcrates.
//
// This is the logical model the UI edits. Nothing here touches the disk; the
// Serato `.crate` files are generated from it elsewhere. Every function
// returns a new tree and leaves the one it was given untouched, so React
// state updates stay cheap to reason about.

export interface CrateNode {
  id: string;
  name: string;
  children: CrateNode[];
  /** Absolute paths of the tracks in this crate, using "/". */
  tracks: string[];
}

/** The roots are the collections. */
export type CrateTree = CrateNode[];

export const DEFAULT_CRATE_NAME = "New Crate";

/**
 * Picks a name no sibling already uses: "New Crate", then "New Crate 2",
 * "New Crate 3", … Comparison ignores case because crate files collide on
 * case-insensitive drives.
 */
export function uniqueName(siblings: CrateNode[], base = DEFAULT_CRATE_NAME): string {
  const taken = new Set(siblings.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Why a crate can't be called `name` among `siblings`, or null when it can.
 * `selfId` excludes the crate being renamed from the clash check.
 */
export function crateNameError(
  name: string,
  siblings: CrateNode[],
  selfId?: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A crate needs a name.";
  if (trimmed !== name) return "A crate name can't start or end with a space.";
  if (name.includes("%%")) return 'A crate name can\'t contain "%%".';
  if (/[\x00-\x1f]/.test(name)) return "A crate name can't contain control characters.";
  const lower = name.toLowerCase();
  if (siblings.some((s) => s.id !== selfId && s.name.toLowerCase() === lower)) {
    return `There is already a crate called "${name}" here.`;
  }
  return null;
}

/** The crate with this id, or undefined. */
export function findCrate(tree: CrateTree, id: string): CrateNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const hit = findCrate(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The crates above `id`, outermost first. Empty for a collection, undefined
 * when the id isn't in the tree.
 */
export function ancestorsOf(tree: CrateTree, id: string): CrateNode[] | undefined {
  for (const node of tree) {
    if (node.id === id) return [];
    const below = ancestorsOf(node.children, id);
    if (below) return [node, ...below];
  }
  return undefined;
}

/** The siblings of `id` (including itself), or the roots when id is null. */
export function siblingsOf(tree: CrateTree, id: string | null): CrateNode[] {
  if (id === null) return tree;
  const ancestors = ancestorsOf(tree, id);
  if (!ancestors) return [];
  return ancestors.length === 0 ? tree : ancestors[ancestors.length - 1].children;
}

/**
 * Adds a crate under `parentId`, or a new collection when parentId is null.
 * With no name given, a unique default is chosen. Throws when the parent is
 * missing or the name is invalid among its new siblings.
 */
export function addCrate(
  tree: CrateTree,
  parentId: string | null,
  name?: string,
  id: string = newId(),
): { tree: CrateTree; node: CrateNode } {
  const siblings = parentId === null ? tree : findCrate(tree, parentId)?.children;
  if (!siblings) throw new Error("Parent crate not found.");

  const finalName = name ?? uniqueName(siblings);
  const error = crateNameError(finalName, siblings);
  if (error) throw new Error(error);

  const node: CrateNode = { id, name: finalName, children: [], tracks: [] };
  const next =
    parentId === null
      ? [...tree, node]
      : mapNode(tree, parentId, (p) => ({ ...p, children: [...p.children, node] }));
  return { tree: next, node };
}

/** Renames a crate. Throws when the name is invalid among its siblings. */
export function renameCrate(tree: CrateTree, id: string, name: string): CrateTree {
  if (!findCrate(tree, id)) throw new Error("Crate not found.");
  const error = crateNameError(name, siblingsOf(tree, id), id);
  if (error) throw new Error(error);
  return mapNode(tree, id, (n) => ({ ...n, name }));
}

/**
 * Adds tracks to a crate. Paths are normalized to "/" and compared without
 * regard to case, since the same file can arrive spelled differently on a
 * case-insensitive drive. Tracks already in the crate are skipped; `added`
 * says how many were new. Throws when the crate is missing.
 */
export function addTracks(
  tree: CrateTree,
  id: string,
  paths: string[],
): { tree: CrateTree; added: number } {
  const crate = findCrate(tree, id);
  if (!crate) throw new Error("Crate not found.");

  const seen = new Set(crate.tracks.map(trackKey));
  const fresh: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const key = trackKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(normalized);
  }
  if (fresh.length === 0) return { tree, added: 0 };

  return {
    tree: mapNode(tree, id, (n) => ({ ...n, tracks: [...n.tracks, ...fresh] })),
    added: fresh.length,
  };
}

function trackKey(path: string): string {
  return path.toLowerCase();
}

/** Removes a crate and everything under it. A missing id is a no-op. */
export function removeCrate(tree: CrateTree, id: string): CrateTree {
  return tree
    .filter((n) => n.id !== id)
    .map((n) => (hasDescendant(n, id) ? { ...n, children: removeCrate(n.children, id) } : n));
}

export interface TreeRow {
  node: CrateNode;
  /** 0 for collections. */
  depth: number;
  parentId: string | null;
}

/**
 * The rows a tree view shows, top to bottom, given which crates are
 * expanded. Children of a collapsed crate are left out.
 */
export function visibleRows(tree: CrateTree, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: CrateNode[], depth: number, parentId: string | null) => {
    for (const node of nodes) {
      rows.push({ node, depth, parentId });
      if (expanded.has(node.id)) walk(node.children, depth + 1, node.id);
    }
  };
  walk(tree, 0, null);
  return rows;
}

function mapNode(tree: CrateTree, id: string, fn: (n: CrateNode) => CrateNode): CrateTree {
  return tree.map((n) => {
    if (n.id === id) return fn(n);
    return hasDescendant(n, id) ? { ...n, children: mapNode(n.children, id, fn) } : n;
  });
}

function hasDescendant(node: CrateNode, id: string): boolean {
  return findCrate(node.children, id) !== undefined;
}

function newId(): string {
  return crypto.randomUUID();
}
