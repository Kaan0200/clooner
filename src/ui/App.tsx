import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ScrollArea } from "@/ui/atoms/scroll-area";
import { durationKey } from "@/core/duration";
import { trackIssues } from "@/core/issues";
import { titleOf } from "@/core/m3u";
import {
  addCrate,
  addTracks,
  ancestorsOf,
  countContents,
  findCrate,
  hasContents,
  moveCrate,
  moveTrack,
  removeCrate,
  removeTrack,
  renameCrate,
  rowKey,
  trackKey,
  visibleRows,
  type CrateNode,
  type TreeRow,
} from "@/core/tree";
import { collectAudioFiles } from "@/lib/library";
import { openCratePlaylist } from "@/lib/playlist";
import { useDurations } from "@/lib/useDurations";
import type { Library } from "@/lib/useLibrary";
import {
  allTrackPaths,
  crateAt,
  describeLength,
  dropAllowed,
  plural,
  type DragState,
  type DropTarget,
} from "@/lib/utils";
import { CrateRow } from "./CrateRow";
import { DragGhost } from "./DragGhost";
import { MainButtons } from "./MainButtons";
import { TrackRow } from "./TrackRow";

interface Props {
  library: Library;
}

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/**
 * Add creates a collection when nothing is selected, or a
 * subcrate under the selected crate. A new crate opens in rename mode.
 * An expanded crate lists its subcrates and then its tracks. Rows can be
 * dragged: a track onto a crate moves it there (Ctrl or Alt adds it instead),
 * a crate onto another nests it, a crate onto empty space makes it a
 * collection. Dragging files from the OS onto a row adds them to that crate.
 */
export default function App({ library }: Props) {
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
  const known = useDurations(
    allTrackPaths(tree),
    library.durations,
    library.setDurations,
  );
  // Sync conflicts and duplicates, recomputed only when the crates or clones change.
  const issues = useMemo(
    () => trackIssues(tree, library.clones),
    [tree, library.clones],
  );

  // A selection can go stale if the tree changes underneath it. The crate a
  // selected track belongs to counts as the selected crate.
  const selectedCrateId = selectedKey?.split("\u0000")[0] ?? null;
  const selected = selectedCrateId
    ? findCrate(tree, selectedCrateId)
    : undefined;
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
      const moved = Math.hypot(
        ev.clientX - current.startX,
        ev.clientY - current.startY,
      );
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
      const target =
        ev.type === "pointerup" ? targetAt(ev.clientX, ev.clientY) : null;
      if (
        target &&
        dropAllowed(latest.current.tree, current.row, target, keep)
      ) {
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
    const crateId =
      element.closest<HTMLElement>("[data-crate-id]")?.dataset.crateId;
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
        latest.current.onChange(
          moveTrack(current, row.crateId, row.path, target.id, keep),
        );
        setExpandedFor(target.id, true);
        setSelectedKey(`${target.id}\u0000${row.path.toLowerCase()}`);
        setNotice(
          `${keep ? "Added" : "Moved"} "${titleOf(row.path)}" ${keep ? "to" : "into"} "${to.name}"`,
        );
      } else {
        const parentId = target.kind === "crate" ? target.id : null;
        latest.current.onChange(moveCrate(current, row.node.id, parentId));
        if (parentId) setExpandedFor(parentId, true);
        setSelectedKey(row.node.id);
        const where = parentId
          ? `into "${findCrate(current, parentId)?.name}"`
          : "to the top level";
        setNotice(`Moved "${row.node.name}" ${where}`);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------------

  async function openPlaylist(crate: CrateNode) {
    if (!library.source || !playlistClone) return;
    const names = [...(ancestorsOf(tree, crate.id) ?? []), crate].map(
      (n) => n.name,
    );
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
      setNotice(
        `Couldn't open the playlist: ${e instanceof Error ? e.message : String(e)}`,
      );
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
      setNotice(
        `Removed "${titleOf(selectedRow.path)}" from "${crate?.name}". The file itself is untouched.`,
      );
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
      const ok = await confirm(
        `"${node.name}" holds ${what}. Delete the crate? Your files stay where they are.`,
        {
          title: "Delete crate",
          kind: "warning",
          okLabel: "Delete",
          cancelLabel: "Keep",
        },
      );
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

  const fileDragging = fileDropTargetId !== null;
  const sourceRoot = library.source?.path ?? null;

  // The crate highlighted as the target of whatever drag is in progress.
  const activeDrag = drag?.active ? drag : null;
  const dragAllowed = activeDrag?.target
    ? dropAllowed(tree, activeDrag.row, activeDrag.target, activeDrag.keep)
    : false;
  const targetCrateId =
    fileDropTargetId ??
    (dragAllowed && activeDrag?.target?.kind === "crate"
      ? activeDrag.target.id
      : null);
  const targetRoot = dragAllowed && activeDrag?.target?.kind === "root";

  const breadcrumb = selected
    ? [...(ancestorsOf(tree, selected.id) ?? []), selected]
        .map((n) => n.name)
        .concat(
          selectedRow?.kind === "track" ? [titleOf(selectedRow.path)] : [],
        )
        .join(" / ")
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MainButtons library={library} add={add} selected={selected} />

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
              if (!(e.target as HTMLElement).closest('[role="treeitem"]'))
                select(null);
            }}
          >
            {rows.map((row) => {
              const key = rowKey(row);
              const beingDragged =
                activeDrag !== null && rowKey(activeDrag.row) === key;
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
                  playlistEnabled={
                    playlistBlocker === null && row.node.tracks.length > 0
                  }
                  length={describeLength(row.node.tracks, known)}
                  onSelect={() => select(key)}
                  onToggle={() =>
                    setExpandedFor(row.node.id, !expanded.has(row.node.id))
                  }
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
            <span
              role="status"
              className="min-w-0 truncate text-foreground"
              title={notice}
            >
              {notice}
            </span>
          )}
        </footer>
      )}

      {activeDrag && (
        <DragGhost drag={activeDrag} allowed={dragAllowed} tree={tree} />
      )}
    </div>
  );
}
