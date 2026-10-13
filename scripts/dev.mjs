// `pnpm dev`: starts `tauri dev`, and on Windows makes sure the app does not
// inherit elevation from an administrator terminal. An elevated window can't
// accept files dragged from Explorer, which the Crates screen relies on.
// See scripts/unelevated.ps1 for how the de-elevation works.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauri = ["pnpm", "tauri", "dev", ...process.argv.slice(2)];

const result =
  process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "unelevated.ps1"), ...tauri],
        { stdio: "inherit" },
      )
    : spawnSync(tauri[0], tauri.slice(1), { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
