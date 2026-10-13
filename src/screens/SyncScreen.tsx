import { useState } from "react";
import { HardDrive, Plus, Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { attachClone, pickFolder, scanLibrary, type CloneResult, type ScanResult } from "@/lib/library";

interface SourceLocation {
  path: string;
  scan: ScanResult | null;
}

interface CloneLocation {
  path: string;
  /** Null while the clone is still being set up. */
  result: CloneResult | null;
  progress: string;
}

export default function SyncScreen() {
  const [source, setSource] = useState<SourceLocation | null>(null);
  const [clones, setClones] = useState<CloneLocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addSource() {
    setError(null);
    const path = await pickFolder("Choose the root folder of your music library");
    if (!path) return;

    setBusy(true);
    setSource({ path, scan: null });
    try {
      setSource({ path, scan: await scanLibrary(path) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addClone() {
    if (!source?.scan) return;
    setError(null);
    const path = await pickFolder("Choose a folder for the clone (empty, or an existing clone)");
    if (!path) return;
    if (clones.some((c) => c.path === path)) {
      setError("That clone is already in the list.");
      return;
    }

    setBusy(true);
    setClones((cs) => [...cs, { path, result: null, progress: "Creating folders…" }]);
    try {
      const result = await attachClone(source.path, path, source.scan, (done, total) => {
        const progress = `Creating folders… ${done.toLocaleString()} / ${total.toLocaleString()}`;
        setClones((cs) => cs.map((c) => (c.path === path ? { ...c, progress } : c)));
      });
      setClones((cs) => cs.map((c) => (c.path === path ? { ...c, result } : c)));
    } catch (e) {
      setClones((cs) => cs.filter((c) => c.path !== path));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex space-x-2 border-b p-2">
        <Button variant="outline" size="lg" title="Add Source Location" onClick={addSource} disabled={busy}>
          <Plus />
          <span>Add Source</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          title={source?.scan ? "Add Clone Location" : "Add a source first"}
          onClick={addClone}
          disabled={busy || !source?.scan}
        >
          <Plus />
          <span>Add A Clone</span>
        </Button>
      </header>

      <div className="flex flex-col gap-2 p-2 text-sm">
        {!source && clones.length === 0 && (
          <div className="text-muted-foreground">No locations yet.</div>
        )}

        {source && (
          <LocationCard icon={HardDrive} kind="Source" path={source.path}>
            {source.scan
              ? `${source.scan.tracks.toLocaleString()} tracks in ${source.scan.folders.length.toLocaleString()} folders`
              : "Scanning…"}
          </LocationCard>
        )}

        {clones.map((clone) => (
          <LocationCard key={clone.path} icon={Usb} kind="Clone" path={clone.path}>
            {clone.result === null ? clone.progress : describeClone(clone.result)}
          </LocationCard>
        ))}

        {error && <div className="text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function describeClone({ existing, folders, tracks }: CloneResult): string {
  const folderText = `${folders.toLocaleString()} folders`;
  if (!existing) return `${folderText} created, no tracks yet`;
  const trackText = tracks === 0 ? "no tracks" : `${tracks.toLocaleString()} tracks`;
  return `Existing clone, ${trackText} in ${folderText}, ready to sync`;
}

function LocationCard({
  icon: Icon,
  kind,
  path,
  children,
}: {
  icon: typeof HardDrive;
  kind: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="font-medium">{kind}</div>
        <div className="truncate text-muted-foreground" title={path}>
          {path}
        </div>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
