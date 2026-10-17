import React from "react";
import ReactDOM from "react-dom/client";
import { useLibrary } from "@/lib/useLibrary";
import App from "@/ui/App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppLoader />
  </React.StrictMode>,
);

export default function AppLoader() {
  // Load persistent library from storage. Survives application reloads.
  const library = useLibrary();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {library.loading ? (
        <div className="p-2 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <App library={library} />
      )}
    </div>
  );
}
