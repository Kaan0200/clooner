import { useState } from "react";
import { FolderSync, HardDrive, Plus, Usb } from "lucide-react";
import { Button } from "@/ui/atoms/button";
import type { CrateNode } from "@/core/tree";
import type { Library } from "@/lib/useLibrary";
import { baseName, cn, plural } from "@/lib/utils";
import { LocationsPanel } from "./LocationsPanel";

interface MainButtonsProps {
  library: Library;
  /** Adds a crate: a collection, or a subcrate of the selected crate. */
  add: () => void;
  /** The crate a new crate would go into. */
  selected?: CrateNode | null;
  /** The selected row as a path of names, shown while no button is hovered. */
  breadcrumb?: string;
}

/** Toolbar buttons are square-ish: the icon sits above the label. */
const TOOL_BUTTON =
  "h-auto min-w-20 flex-col gap-1 px-3 py-2 [&_svg:not([class*='size-'])]:size-5";

/**
 * The toolbar above the crate tree. The top row holds the actions: add a
 * crate, pick or change the source, sync every clone, add a clone, and a
 * toggle that shows the clones with their status. The row below explains
 * whichever button the pointer is over, otherwise names the selected row,
 * and reports progress and problems.
 */
export function MainButtons({
  library,
  add,
  selected,
  breadcrumb,
}: MainButtonsProps) {
  const { source, sourceStatus, clones, cloneStatus, busy, loading } = library;
  const [showLocations, setShowLocations] = useState(false);
  // The help row shows what the hovered (or focused) button would do.
  const [hint, setHint] = useState<string | null>(null);

  const sourceReady = sourceStatus?.kind === "ready";
  const connected = clones.filter(
    (c) => cloneStatus[c.path]?.kind === "ready",
  ).length;

  // Progress of whichever clone is being copied to or synced right now.
  let progress: string | null = null;
  for (const clone of clones) {
    const status = cloneStatus[clone.path];
    if (status?.kind === "working") {
      progress = `${baseName(clone.path)}: ${status.progress}`;
      break;
    }
  }

  const addHint = selected
    ? `Add a subcrate inside "${selected.name}".`
    : "Add a crate at the top level.";

  const sourceHint = source
    ? "Click to point at a different folder: tracks are found again by file name, and nothing is deleted."
    : "Choose the root folder of your music library.";

  const syncHint = !source
    ? "Add a source before syncing."
    : !sourceReady
      ? "The source must be connected to sync."
      : clones.length === 0
        ? "Add a clone before syncing."
        : connected === 0
          ? "No clone is connected right now."
          : busy
            ? "Busy: wait for the current job to finish."
            : `Scan and update ${plural(connected, "connected clone")}: copy newer files both ways, then write the crates and Serato database.`;

  const addCloneHint = sourceReady
    ? "Choose a folder, such as a USB drive, to keep as a clone of the source."
    : "Add a source before adding a clone.";

  const clonesLabel =
    clones.length === 0
      ? "No Clones"
      : connected === clones.length
        ? plural(clones.length, "Clone")
        : `${connected} of ${plural(clones.length, "Clone")}`;
  const clonesHint =
    clones.length === 0
      ? "No clones yet. Add one to keep a copy of the library."
      : `${connected} of ${plural(clones.length, "clone")} connected. Click to ${showLocations ? "hide" : "show"} the list.`;

  const message = library.error ?? library.warning ?? progress;
  // Hovering a button explains it; otherwise the row names the selection.
  const help = hint ?? (breadcrumb || addHint);

  return (
    <div className="border-b">
      <header className="flex flex-wrap items-stretch gap-2 p-2">
        <HintTarget hint={addHint} onHint={setHint}>
          <Button
            variant="outline"
            size="lg"
            className={TOOL_BUTTON}
            onClick={add}
          >
            <Plus />
            <span>Add Crate</span>
          </Button>
        </HintTarget>

        <HintTarget hint={sourceHint} onHint={setHint}>
          <Button
            variant="outline"
            size="lg"
            className={cn(TOOL_BUTTON, "max-w-56")}
            onClick={library.changeSource}
            disabled={busy || loading}
          >
            {source ? <HardDrive /> : <Plus />}
            <span className="truncate">
              {source ? baseName(source.path) : "Add Source"}
            </span>
          </Button>
        </HintTarget>

        <HintTarget hint={syncHint} onHint={setHint}>
          <Button
            variant="outline"
            size="lg"
            className={TOOL_BUTTON}
            onClick={library.syncAll}
            disabled={busy || !sourceReady || connected === 0}
          >
            <FolderSync />
            <span>Sync</span>
          </Button>
        </HintTarget>

        <HintTarget hint={addCloneHint} onHint={setHint}>
          <Button
            variant="outline"
            size="lg"
            className={TOOL_BUTTON}
            onClick={library.addClone}
            disabled={busy || !sourceReady}
          >
            <Plus />
            <span>Add Clone</span>
          </Button>
        </HintTarget>

        <HintTarget hint={clonesHint} onHint={setHint}>
          <Button
            variant={showLocations ? "default" : "outline"}
            size="lg"
            className={TOOL_BUTTON}
            aria-pressed={showLocations}
            aria-expanded={showLocations}
            onClick={() => setShowLocations((v) => !v)}
            disabled={loading}
          >
            <Usb />
            <span>{clonesLabel}</span>
          </Button>
        </HintTarget>
      </header>

      <div className="flex min-h-6 items-center justify-between gap-3 px-3 pb-1.5 text-xs text-muted-foreground">
        <span className="truncate" title={help}>
          {help}
        </span>
        {message && (
          <span
            role="status"
            className={`min-w-0 shrink-0 truncate ${library.error ? "text-destructive" : "text-foreground"}`}
            title={message}
          >
            {message}
          </span>
        )}
      </div>

      {showLocations && <LocationsPanel library={library} />}
    </div>
  );
}

/**
 * Wraps a toolbar button so that hovering or focusing it puts its hint in
 * the help row. The wrapper takes the pointer events because a disabled
 * button ignores them, and that is exactly when the hint says why.
 */
function HintTarget({
  hint,
  onHint,
  children,
}: {
  hint: string;
  onHint: (hint: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex"
      onPointerEnter={() => onHint(hint)}
      onPointerLeave={() => onHint(null)}
      onFocus={() => onHint(hint)}
      onBlur={() => onHint(null)}
    >
      {children}
    </span>
  );
}

export default MainButtons;
