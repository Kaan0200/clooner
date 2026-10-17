import { Music } from "lucide-react";
import { formatDuration } from "@/core/duration";
import type { TrackIssue } from "@/core/issues";
import { titleOf } from "@/core/m3u";
import type { TreeRow } from "@/core/tree";
import { INDENT_PX, folderOf, rowBackground } from "@/lib/utils";
import { IssueDot } from "./IssueDot";
import { SelectionMarker } from "./SelectionMarker";

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

export function TrackRow({
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
      {folder && (
        <span className="ml-1 truncate text-xs text-muted-foreground">
          {folder}
        </span>
      )}
      {duration !== undefined && (
        <span className="ml-auto shrink-0 pr-1 text-xs tabular-nums text-muted-foreground">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}
