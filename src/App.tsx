import { useState } from "react";
import { FolderTree, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLibrary } from "@/lib/useLibrary";
import CratesScreen from "@/screens/CratesScreen";
import SyncScreen from "@/screens/SyncScreen";

type View = "crates" | "sync" | "settings";

export default function App() {
  const [view, setView] = useState<View>("crates");
  // Everything persistent lives here, so it survives switching views and is
  // saved to the app database after every change.
  const library = useLibrary();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex justify-between border-b p-2 gb-muted">
        <Button
          variant={view === "crates" ? "default" : "outline"}
          size="lg"
          aria-label="Crates"
          aria-pressed={view === "crates"}
          title="Crates"
          onClick={() => setView("crates")}
        >
          <FolderTree />
          <span>Crates</span>
        </Button>

        <Button
          variant={view === "sync" ? "default" : "outline"}
          size="lg"
          aria-label="Sync"
          aria-pressed={view === "sync"}
          title="Sync"
          onClick={() => setView("sync")}
        >
          <RefreshCw />
          <span>Sync</span>
        </Button>
      </header>

      {view === "crates" &&
        (library.loading ? (
          <div className="p-2 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <CratesScreen library={library} />
        ))}
      {view === "sync" && <SyncScreen library={library} />}
    </div>
  );
}
