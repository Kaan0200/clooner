import { useState } from "react";
import { FolderSync, HardDrive, Plus, Usb } from "lucide-react";
import { Button } from "@/ui/atoms/button";
import type { CrateNode } from "@/core/tree";
import type { Library } from "@/lib/useLibrary";
import { baseName, describeSource, plural } from "@/lib/utils";
import { LocationsPanel } from "./LocationsPanel";

interface MainButtonsProps {
  library: Library;
  /** Adds a crate: a collection, or a subcrate of the selected crate. */
  add: () => void;
  /** The crate a new crate would go into. */
  selected?: CrateNode | null;
}

/**
 * The toolbar above the crate tree. The top row holds the actions: add a
 * crate, pick or change the source, sync every clone, add a clone, and a
 * toggle that shows the clones with their status. The row below explains
 * what Add will do and reports progress and problems.
 */
export function MainButtons({ library, add, selected }: MainButtonsProps) {
  const { source, sourceStatus, clones, cloneStatus, busy, loading } = library;
  const [showLocations, setShowLocations] = useState(false);

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

  const addTitle = selected
    ? `Add a subcrate to "${selected.name}"`
    : "Add a collection";

  const sourceTitle = source
    ? `${source.path}\n${describeSource(sourceStatus)}\nClick to change the source library`
    : "Add Source Location";

  const syncTitle = !source
    ? "Add a source first"
    : !sourceReady
      ? "The source must be connected to sync"
      : clones.length === 0
        ? "Add a clone first"
        : connected === 0
          ? "No clone is connected"
          : busy
            ? "Busy"
            : `Sync ${plural(connected, "connected clone")}: copy newer files both ways, then write the crates and database`;

  const clonesLabel =
    clones.length === 0
      ? "No Clones"
      : connected === clones.length
        ? plural(clones.length, "Clone")
        : `${connected} of ${plural(clones.length, "Clone")}`;
  const clonesTitle =
    clones.length === 0
      ? "No clones yet"
      : `${connected} of ${plural(clones.length, "clone")} connected. Click to ${showLocations ? "hide" : "show"} them`;

  const message = library.error ?? library.warning ?? progress;

  return (
    <div className="border-b">
      <header className="flex flex-wrap items-center gap-2 p-2">
        <Button variant="outline" size="lg" title={addTitle} onClick={add}>
          <Plus />
          <span>Add Crate</span>
        </Button>

        <Button
          variant="outline"
          size="lg"
          className="max-w-56"
          title={sourceTitle}
          onClick={library.addSource}
          disabled={busy || loading}
        >
          {source ? <HardDrive /> : <Plus />}
          <span className="truncate">
            {source ? baseName(source.path) : "Add Source"}
          </span>
          {source && <StatusDot kind={sourceStatus?.kind} />}
        </Button>

        <Button
          variant="outline"
          size="lg"
          title={syncTitle}
          onClick={library.syncAll}
          disabled={busy || !sourceReady || connected === 0}
        >
          <FolderSync />
          <span>Sync</span>
        </Button>

        <Button
          variant="outline"
          size="lg"
          title={sourceReady ? "Add Clone Location" : "Add a source first"}
          onClick={library.addClone}
          disabled={busy || !sourceReady}
        >
          <Plus />
          <span>Add Clone</span>
        </Button>

        <Button
          variant={showLocations ? "default" : "outline"}
          size="lg"
          aria-pressed={showLocations}
          aria-expanded={showLocations}
          title={clonesTitle}
          onClick={() => setShowLocations((v) => !v)}
          disabled={loading}
        >
          <Usb />
          <span>{clonesLabel}</span>
        </Button>
      </header>

      <div className="flex min-h-6 items-center justify-between gap-3 px-3 pb-1.5 text-xs text-muted-foreground">
        <span className="truncate">
          {selected ? (
            <>
              Add puts a subcrate in{" "}
              <span className="font-medium">{selected.name}</span>
            </>
          ) : (
            "Add creates a collection"
          )}
        </span>
        {message && (
          <span
            role="status"
            className={`min-w-0 truncate ${library.error ? "text-destructive" : "text-foreground"}`}
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

/** A small dot that shows whether the source is connected. */
function StatusDot({ kind }: { kind: string | undefined }) {
  const color =
    kind === "ready"
      ? "bg-emerald-500"
      : kind === "scanning"
        ? "bg-amber-500"
        : "bg-destructive";
  return (
    <span aria-hidden className={`size-2 shrink-0 rounded-full ${color}`} />
  );
}

export default MainButtons;
