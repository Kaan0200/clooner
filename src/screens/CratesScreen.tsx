import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { ChevronRight, Folder, FolderOpen, ListMusic, Music, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isInside, normalizeRoot } from "@/core/clone";
import { durationKey, formatDuration, sumDurations } from "@/core/duration";
import { trackIssues, type TrackIssue } from "@/core/issues";
import { titleOf } from "@/core/m3u";
import {
  addCrate,
  addTracks,
  ancestorsOf,
  countContents,
  findCrate,
  hasContents,
  isWithin,
  moveCrate,
  moveTrack,
  removeCrate,
  removeTrack,
  renameCrate,
  rowKey,
  trackKey,
  visibleRows,
  type CrateNode,
  type CrateTree,
  type TreeRow,
} from "@/core/tree";
import { collectAudioFiles } from "@/lib/library";
import { openCratePlaylist } from "@/lib/playlist";
import { useDurations } from "@/lib/useDurations";
import type { Library } from "@/lib/useLibrary";

interface Props {
  library: Library;
}

const INDENT_PX = 16;
/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/** Where an in-app drag is hovering: a crate row, or the empty space (top level). */
type DropTarget = { kind: "crate"; id: string } | { kind: "root" };

interface DragState {
  row: TreeRow;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** False until the pointer has moved past the threshold. */
  active: boolean;
  target: DropTarget | null;
  /** Ctrl or Alt held: a track is added to the target while staying where it was. */
  keep: boolean;
}

/**
 * The crate tree. Add creates a collection when nothing is selected, or a
 * subcrate under the selected crate. A new crate opens in rename mode.
 * An expanded crate lists its subcrates and then its tracks. Rows can be
 * dragged: a track onto a crate moves it there (Ctrl or Alt adds it instead),
 * a crate onto another nests it, a crate onto empty space makes it a
 * collection. Dragging files from the OS onto a row adds them to that crate.
 */
export default function CratesScreen({ library }: Props) {
  const tree = library.crates;
  const onChange = library.setCrates;

  /** The selected row's key: a crate id, or a crate id plus a track path. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The crate under the cursor while files are being dragged over the window. */
  const [fileDropTargetId, setFileDropTargetId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const rows = visibleRows(tree, expanded);

  // Track lengths: known ones come from the database, the rest are read from
  // the files in the background and saved as they arrive.
  const known = useDurations(allTrackPaths(tree), library.durations, library.setDurations);
  // Sync conflicts and duplicates, recomputed only when the crates or clones change.
  const issues = useMemo(() => trackIssues(tree, library.clones), [tree, library.clones]);

  // A selection can go stale if the tree changes underneath it. The crate a
  // selected track belongs to counts as the selected crate.
  const selectedCrateId = selectedKey?.split("\u0000")[0] ?? null;
  const selected = selectedCrateId ? findCrate(tree, selectedCrateId) : undefined;
  const selectedRow = rows.find((r) => rowKey(r) === selectedKey);

  // Playlists are written into the first clone that is connected right now.
  const playlistClone = library.clones.find(
    (c) => library.cloneStatus[c.path]?.kind === "ready",
  );
  const playlistBlocker = !library.source
    ? "Add a source library first"
    : !playlistClone
      ? "No clone is connected"
      : null;

  useEffect(() => {
    if (!selectedKey) return;
    treeRef.current
      ?.querySelector(`[data-row-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, rows.length]);

  // Handlers that outlive a render read the latest state through refs.
  const latest = useRef({ tree, onChange, copyToClones: library.copyToClones });
  latest.current = { tree, onChange, copyToClones: library.copyToClones };

  useEffect(() => {
    // Outside Tauri (plain browser dev) there is no native drag-drop channel.
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        switch (payload.type) {
          case "enter":
          case "over":
            setFileDropTargetId(crateAt(payload.position));
            break;
          case "drop": {
            setFileDropTargetId(null);
            const id = crateAt(payload.position);
            if (id) void dropFiles(id, payload.paths);
            break;
          }
          case "leave":
            setFileDropTargetId(null);
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function dropFiles(crateId: string, paths: string[]) {
    const crate = findCrate(latest.current.tree, crateId);
    if (!crate) return;

    let files: string[];
    try {
      files = await collectAudioFiles(paths);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      return;
    }
    if (files.length === 0) {
      setNotice(`Nothing in that drop was an audio file.`);
      return;
    }

    // The tree may have changed while files were being listed.
    const fresh = latest.current.tree;
    if (!findCrate(fresh, crateId)) return;
    const { tree: next, added } = addTracks(fresh, crateId, files);
    if (added > 0) latest.current.onChange(next);
    const skipped = files.length - added;
    const membership =
      `${plural(added, "track")} added to "${crate.name}"` +
      (skipped > 0 ? `, ${skipped} already there` : "");
    setSelectedKey(crateId);
    setExpandedFor(crateId, true);

    // The files go onto every connected clone right away.
    setNotice(`${membership}. Copying to clones…`);
    const copy = await latest.current.copyToClones(files);
    const copied =
      copy.clones === 0
        ? "no clone is connected, so nothing was copied"
        : `${plural(copy.copied, "file")} copied to ${plural(copy.clones, "clone")}`;
    setNotice(`${membership}; ${copied}.`);
  }

  // --- In-app dragging of rows -------------------------------------------

  const dragRef = useRef<DragState | null>(null);
  /** Set when a drag just ended, so the click that follows doesn't reselect. */
  const swallowClick = useRef(false);

  function startDrag(row: TreeRow, e: React.PointerEvent) {
    if (e.button !== 0 || editingId) return;
    // Buttons and the rename field handle their own presses.
    if ((e.target as HTMLElement).closest("button, input")) return;

    const state: DragState = {
      row,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      target: null,
      keep: false,
    };
    dragRef.current = state;

    const onMove = (ev: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const moved = Math.hypot(ev.clientX - current.startX, ev.clientY - current.startY);
      if (!current.active && moved < DRAG_THRESHOLD_PX) return;
      const next: DragState = {
        ...current,
        active: true,
        x: ev.clientX,
        y: ev.clientY,
        target: targetAt(ev.clientX, ev.clientY),
        keep: ev.ctrlKey || ev.altKey,
      };
      dragRef.current = next;
      setDrag(next);
      ev.preventDefault();
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current?.active) return;
      swallowClick.current = true;
      const keep = ev.ctrlKey || ev.altKey;
      const target = ev.type === "pointerup" ? targetAt(ev.clientX, ev.clientY) : null;
      if (target && dropAllowed(latest.current.tree, current.row, target, keep)) {
        finishDrag(current.row, target, keep);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "grabbing";
  }

  /** The drop target under a point: a crate row, the tree's empty space, or nothing. */
  function targetAt(x: number, y: number): DropTarget | null {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    const crateId = element.closest<HTMLElement>("[data-crate-id]")?.dataset.crateId;
    if (crateId) return { kind: "crate", id: crateId };
    return treeRef.current?.contains(element) ? { kind: "root" } : null;
  }

  function finishDrag(row: TreeRow, target: DropTarget, keep: boolean) {
    const current = latest.current.tree;
    try {
      if (row.kind === "track") {
        if (target.kind !== "crate") return;
        const to = findCrate(current, target.id);
        if (!to) return;
        latest.current.onChange(moveTrack(current, row.crateId, row.path, target.id, keep));
        setExpandedFor(target.id, true);
        setSelectedKey(`${target.id}\u0000${row.path.toLowerCase()}`);
        setNotice(`${keep ? "Added" : "Moved"} "${titleOf(row.path)}" ${keep ? "to" : "into"} "${to.name}"`);
      } else {
        const parentId = target.kind === "crate" ? target.id : null;
        latest.current.onChange(moveCrate(current, row.node.id, parentId));
        if (parentId) setExpandedFor(parentId, true);
        setSelectedKey(row.node.id);
        const where = parentId ? `into "${findCrate(current, parentId)?.name}"` : "to the top level";
        setNotice(`Moved "${row.node.name}" ${where}`);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------------

  async function openPlaylist(crate: CrateNode) {
    if (!library.source || !playlistClone) return;
    const names = [...(ancestorsOf(tree, crate.id) ?? []), crate].map((n) => n.name);
    setSelectedKey(crate.id);
    setNotice(`Opening "${crate.name}" as a playlist…`);
    try {
      const result = await openCratePlaylist({
        crateNames: names,
        tracks: crate.tracks,
        sourceRoot: library.source.path,
        cloneRoot: playlistClone.path,
      });
      const outside =
        result.outsideLibrary > 0
          ? `, ${plural(result.outsideLibrary, "track")} outside the library listed as-is`
          : "";
      setNotice(`Opened ${result.file}${outside}`);
    } catch (e) {
      setNotice(`Couldn't open the playlist: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function setExpandedFor(id: string, open: boolean) {
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function add() {
    const parentId = selected?.id ?? null;
    const result = addCrate(tree, parentId);
    onChange(result.tree);
    if (parentId) setExpandedFor(parentId, true);
    setSelectedKey(result.node.id);
    setEditingId(result.node.id);
    setNotice(null);
  }

  function select(key: string | null) {
    setSelectedKey(key);
    setEditingId(null);
  }

  /** Delete on a track takes it out of its crate; on a crate, removes the crate. */
  async function removeSelected() {
    if (!selectedRow) return;
    if (selectedRow.kind === "track") {
      const crate = findCrate(tree, selectedRow.crateId);
      onChange(removeTrack(tree, selectedRow.crateId, selectedRow.path));
      setSelectedKey(selectedRow.crateId);
      setNotice(`Removed "${titleOf(selectedRow.path)}" from "${crate?.name}". The file itself is untouched.`);
      return;
    }

    const { node, parentId } = selectedRow;
    const inside = countContents(node);
    // An empty crate goes without asking; one with contents is worth a pause,
    // since a keypress would otherwise drop a whole collection.
    if (inside.crates > 0 || inside.tracks > 0) {
      const what = [
        inside.crates > 0 && plural(inside.crates, "subcrate"),
        inside.tracks > 0 && plural(inside.tracks, "track"),
      ]
        .filter(Boolean)
        .join(" and ");
      const ok = await confirm(`"${node.name}" holds ${what}. Delete the crate? Your files stay where they are.`, {
        title: "Delete crate",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Keep",
      });
      if (!ok) return;
    }
    onChange(removeCrate(latest.current.tree, node.id));
    setSelectedKey(parentId);
    setNotice(`Deleted "${node.name}". No files were touched.`);
  }

  /** Commits a rename. Returns the error to show, or null when it went through. */
  function commitRename(id: string, name: string): string | null {
    const current = findCrate(tree, id);
    if (!current) return null;
    if (name !== current.name) {
      try {
        onChange(renameCrate(tree, id, name));
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    setEditingId(null);
    treeRef.current?.focus();
    return null;
  }

  function cancelRename() {
    setEditingId(null);
    treeRef.current?.focus();
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (editingId) return;
    const index = rows.findIndex((r) => rowKey(r) === selectedKey);
    const row = index >= 0 ? rows[index] : undefined;
    const moveTo = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (target) select(rowKey(target));
    };

    switch (e.key) {
      case "ArrowDown":
        moveTo(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
        moveTo(index < 0 ? rows.length - 1 : index - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.kind !== "crate" || !hasContents(row.node)) return;
        if (expanded.has(row.node.id)) moveTo(index + 1);
        else setExpandedFor(row.node.id, true);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (row.kind === "track") select(row.crateId);
        else if (expanded.has(row.node.id)) setExpandedFor(row.node.id, false);
        else if (row.parentId) select(row.parentId);
        break;
      case "Enter":
      case "F2":
        if (row?.kind === "crate") setEditingId(row.node.id);
        break;
      case "Delete":
      case "Backspace":
        if (!row) return;
        void removeSelected();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  const addTitle = selected ? `Add a subcrate to "${selected.name}"` : "Add a collection";
  const fileDragging = fileDropTargetId !== null;
  const sourceRoot = library.source?.path ?? null;

  // The crate highlighted as the target of whatever drag is in progress.
  const activeDrag = drag?.active ? drag : null;
  const dragAllowed =
    activeDrag?.target ? dropAllowed(tree, activeDrag.row, activeDrag.target, activeDrag.keep) : false;
  const targetCrateId =
    fileDropTargetId ??
    (dragAllowed && activeDrag?.target?.kind === "crate" ? activeDrag.target.id : null);
  const targetRoot = dragAllowed && activeDrag?.target?.kind === "root";

  const breadcrumb = selected
    ? [...(ancestorsOf(tree, selected.id) ?? []), selected]
        .map((n) => n.name)
        .concat(selectedRow?.kind === "track" ? [titleOf(selectedRow.path)] : [])
        .join(" / ")
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b p-2">
        <Button variant="outline" size="lg" title={addTitle} onClick={add}>
          <Plus />
          <span>Add</span>
        </Button>
        {selected && (
          <span className="truncate text-xs text-muted-foreground">
            Add puts a subcrate in <span className="font-medium">{selected.name}</span>
          </span>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">
            No crates yet. Add creates your first collection.
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Crates"
            tabIndex={0}
            className={`flex min-h-full flex-col rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              targetRoot ? "ring-2 ring-inset ring-primary" : ""
            }`}
            onKeyDown={onTreeKeyDown}
            onClickCapture={(e) => {
              if (!swallowClick.current) return;
              swallowClick.current = false;
              e.stopPropagation();
            }}
            // Clicking empty space clears the selection so Add makes a collection.
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('[role="treeitem"]')) select(null);
            }}
          >
            {rows.map((row) => {
              const key = rowKey(row);
              const beingDragged = activeDrag !== null && rowKey(activeDrag.row) === key;
              if (row.kind === "track") {
                return (
                  <TrackRow
                    key={key}
                    rowKey={key}
                    row={row}
                    sourceRoot={sourceRoot}
                    selected={key === selectedKey}
                    dropTarget={row.crateId === targetCrateId}
                    dragging={fileDragging}
                    beingDragged={beingDragged}
                    duration={known[durationKey(row.path)]}
                    issues={issues.get(trackKey(row.path))}
                    onSelect={() => select(key)}
                    onPointerDown={(e) => startDrag(row, e)}
                  />
                );
              }
              return (
                <CrateRow
                  key={key}
                  row={row}
                  selected={key === selectedKey}
                  expanded={expanded.has(row.node.id)}
                  editing={row.node.id === editingId}
                  dropTarget={row.node.id === targetCrateId}
                  dragging={fileDragging}
                  beingDragged={beingDragged}
                  playlistTitle={
                    playlistBlocker ??
                    (row.node.tracks.length === 0
                      ? "This crate has no tracks yet"
                      : `Open as a playlist from ${playlistClone!.path}`)
                  }
                  playlistEnabled={playlistBlocker === null && row.node.tracks.length > 0}
                  length={describeLength(row.node.tracks, known)}
                  onSelect={() => select(key)}
                  onToggle={() => setExpandedFor(row.node.id, !expanded.has(row.node.id))}
                  onEdit={() => setEditingId(row.node.id)}
                  onCommit={(name) => commitRename(row.node.id, name)}
                  onCancel={cancelRename}
                  onOpenPlaylist={() => void openPlaylist(row.node)}
                  onPointerDown={(e) => startDrag(row, e)}
                />
              );
            })}
            {/* Fills the rest of the panel so clicks below the last row deselect. */}
            <div className="flex-1" />
          </div>
        )}
      </ScrollArea>

      {(notice || breadcrumb.includes(" / ")) && (
        <footer className="flex items-center justify-between gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">{breadcrumb}</span>
          {notice && (
            <span role="status" className="min-w-0 truncate text-foreground" title={notice}>
              {notice}
            </span>
          )}
        </footer>
      )}

      {activeDrag && <DragGhost drag={activeDrag} allowed={dragAllowed} tree={tree} />}
    </div>
  );
}

/** Whether a dragged row may be dropped on a target. */
function dropAllowed(tree: CrateTree, row: TreeRow, target: DropTarget, keep: boolean): boolean {
  if (row.kind === "track") {
    if (target.kind !== "crate" || target.id === row.crateId) return false;
    const to = findCrate(tree, target.id);
    // Adding is pointless when the track is already there.
    return !!to && (!keep || !to.tracks.some((t) => t.toLowerCase() === row.path.toLowerCase()));
  }
  if (target.kind === "root") return row.parentId !== null;
  return target.id !== row.parentId && !isWithin(tree, row.node.id, target.id);
}

/** The label that follows the pointer during an in-app drag. */
function DragGhost({ drag, allowed, tree }: { drag: DragState; allowed: boolean; tree: CrateTree }) {
  const name = drag.row.kind === "track" ? titleOf(drag.row.path) : drag.row.node.name;
  const Icon = drag.row.kind === "track" ? Music : Folder;

  let action: string | null = null;
  if (allowed && drag.target) {
    if (drag.target.kind === "root") action = "Make a collection";
    else {
      const to = findCrate(tree, drag.target.id)?.name ?? "";
      action = drag.row.kind === "track" && drag.keep ? `Add to "${to}"` : `Move into "${to}"`;
    }
  }

  return (
    <div
      className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-2 rounded-md border bg-popover px-2 py-1 text-sm shadow-md"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      {action && <span className="shrink-0 text-xs font-medium text-primary">{action}</span>}
    </div>
  );
}

/**
 * The crate under a point reported by the native drag, which comes in
 * physical pixels relative to the webview. A track row stands in for the
 * crate that holds it.
 */
function crateAt(position: PhysicalPosition): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  return element?.closest<HTMLElement>("[data-crate-id]")?.dataset.crateId ?? null;
}

/** Every track path in the tree, in tree order. */
function allTrackPaths(tree: CrateTree): string[] {
  const out: string[] = [];
  const walk = (nodes: CrateNode[]) => {
    for (const node of nodes) {
      out.push(...node.tracks);
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/** "12 tracks · 48:32", with a note when some lengths aren't known yet. */
function describeLength(paths: string[], known: Record<string, number>): { text: string; title: string } {
  const { seconds, unknown } = sumDurations(paths, known);
  const count = plural(paths.length, "track");
  if (unknown === paths.length) return { text: "", title: `${count}, lengths not read yet` };
  const time = formatDuration(seconds);
  const title =
    unknown > 0 ? `${count}, ${time} not counting ${plural(unknown, "track")} of unknown length` : `${count}, ${time}`;
  return { text: unknown > 0 ? `${time}+` : time, title };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** The thin bar at a row's left edge that marks it as selected. */
function SelectionMarker({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-primary transition-opacity ${
        selected ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}

/** Row background for the states a row can be in. */
function rowBackground(dropTarget: boolean, dragging: boolean, selected: boolean): string {
  if (dropTarget) return "bg-primary/10 ring-2 ring-inset ring-primary";
  // While files are dragged over the window every row is a potential target,
  // so hint at it without shouting.
  if (dragging) return "ring-1 ring-inset ring-dashed ring-border";
  if (selected) return "bg-muted text-foreground";
  return "hover:bg-muted/50";
}

interface TrackRowProps {
  rowKey: string;
  row: Extract<TreeRow, { kind: "track" }>;
  sourceRoot: string | null;
  selected: boolean;
  /** Something is being dragged over this row's crate right now. */
  dropTarget: boolean;
  /** Files are being dragged over the window. */
  dragging: boolean;
  /** This row is the one being dragged. */
  beingDragged: boolean;
  /** Length in seconds, when known. */
  duration?: number;
  /** Anything about this track that wants attention; shown as a dot. */
  issues?: TrackIssue[];
  onSelect: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

function TrackRow({
  rowKey,
  row,
  sourceRoot,
  selected,
  dropTarget,
  dragging,
  beingDragged,
  duration,
  issues,
  onSelect,
  onPointerDown,
}: TrackRowProps) {
  const path = row.path;
  const title = titleOf(path);
  // Where the file sits, relative to the library when it is inside it.
  const folder = folderOf(path, sourceRoot);

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      data-row-key={rowKey}
      data-crate-id={row.crateId}
      title={path}
      className={`relative flex h-7 cursor-default items-center gap-1 rounded-md pr-1 text-sm transition-colors select-none ${rowBackground(dropTarget, dragging, selected)} ${
        beingDragged ? "opacity-40" : ""
      }`}
      style={{ paddingLeft: 4 + row.depth * INDENT_PX }}
      onClick={onSelect}
      onPointerDown={onPointerDown}
    >
      <SelectionMarker selected={selected} />
      {/* Where a crate row has its chevron, a track row has room for its dot. */}
      <span className="flex size-5 shrink-0 items-center justify-center">
        {issues && issues.length > 0 && <IssueDot issues={issues} />}
      </span>
      <Music className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
      {folder && <span className="ml-1 truncate text-xs text-muted-foreground">{folder}</span>}
      {duration !== undefined && (
        <span className="ml-auto shrink-0 pr-1 text-xs tabular-nums text-muted-foreground">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}

/**
 * The dot on a track row. Red for a sync conflict, since an edit may have
 * been lost; amber for a duplicate. Hovering it explains every issue.
 */
function IssueDot({ issues }: { issues: TrackIssue[] }) {
  const detail = issues.map((i) => i.detail).join("\n\n");
  const color = issues[0].kind === "sync" ? "bg-destructive" : "bg-amber-500";
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      // Padding makes the dot easier to hover than its two pixels alone.
      className="flex size-5 items-center justify-center"
    >
      <span className={`size-2 rounded-full ${color}`} />
    </span>
  );
}

/** The folder part of a path, relative to the library root when inside it. Empty at the root. */
function folderOf(path: string, sourceRoot: string | null): string {
  const normalized = normalizeRoot(path);
  const dir = normalized.slice(0, normalized.lastIndexOf("/"));
  if (sourceRoot && isInside(sourceRoot, dir)) return dir.slice(normalizeRoot(sourceRoot).length + 1);
  return dir;
}

interface RowProps {
  row: Extract<TreeRow, { kind: "crate" }>;
  selected: boolean;
  expanded: boolean;
  editing: boolean;
  /** Something is being dragged over this row right now. */
  dropTarget: boolean;
  /** Files are being dragged over the window. */
  dragging: boolean;
  /** This row is the one being dragged. */
  beingDragged: boolean;
  /** Tooltip for the playlist button: what it does, or why it is disabled. */
  playlistTitle: string;
  playlistEnabled: boolean;
  /** The crate's total length, ready to show, and its tooltip. */
  length: { text: string; title: string };
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
  onOpenPlaylist: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

function CrateRow({
  row,
  selected,
  expanded,
  editing,
  dropTarget,
  dragging,
  beingDragged,
  playlistTitle,
  playlistEnabled,
  length,
  onSelect,
  onToggle,
  onEdit,
  onCommit,
  onCancel,
  onOpenPlaylist,
  onPointerDown,
}: RowProps) {
  const { node, depth } = row;
  const expandable = hasContents(node);
  const Icon = expanded && expandable ? FolderOpen : Folder;

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
      data-row-key={node.id}
      data-crate-id={node.id}
      data-drop-target={dropTarget || undefined}
      className={`group/row relative flex h-8 cursor-default items-center gap-1 rounded-md pr-1 text-sm transition-colors select-none ${rowBackground(dropTarget, dragging, selected)} ${
        beingDragged ? "opacity-40" : ""
      }`}
      style={{ paddingLeft: 4 + depth * INDENT_PX }}
      onClick={onSelect}
      onDoubleClick={onEdit}
      onPointerDown={onPointerDown}
    >
      <SelectionMarker selected={selected} />
      {expandable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight
            className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <Icon className={`size-4 shrink-0 ${dropTarget ? "text-primary" : "text-muted-foreground"}`} />
      {editing ? (
        <RenameInput initial={node.name} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className="truncate">{node.name}</span>
      )}

      {dropTarget ? (
        <span className="ml-auto shrink-0 pr-1 text-xs font-medium text-primary">Drop here</span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {node.tracks.length > 0 && (
            <span
              className="flex items-center gap-1 pr-1 text-xs tabular-nums text-muted-foreground"
              title={length.title}
            >
              <Music className="size-3" />
              {node.tracks.length.toLocaleString()}
              {length.text && <span className="text-muted-foreground/70">· {length.text}</span>}
            </span>
          )}
          {/* Row actions: shown on hover or when the row is selected. */}
          <span
            className={`flex items-center gap-0.5 transition-opacity group-hover/row:opacity-100 ${
              selected ? "opacity-100" : "opacity-0"
            }`}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label="Open as playlist"
              title={playlistTitle}
              disabled={!playlistEnabled}
              onClick={onOpenPlaylist}
            >
              <ListMusic />
            </Button>
          </span>
        </span>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function commit() {
    setError(onCommit(draft));
  }

  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        aria-label="Crate name"
        aria-invalid={error ? true : undefined}
        className={`h-6 w-full rounded border bg-background px-1 text-sm outline-none focus-visible:ring-2 ${
          error ? "border-destructive ring-destructive/30" : "border-input ring-ring/50"
        }`}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        // Leaving the field keeps a valid name and drops an invalid one.
        onBlur={() => {
          if (onCommit(draft)) onCancel();
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {error && (
        <span
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 rounded-md border bg-popover px-2 py-1 text-xs text-destructive shadow-md"
        >
          {error}
        </span>
      )}
    </span>
  );
}
