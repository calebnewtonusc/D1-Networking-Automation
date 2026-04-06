/**
 * Auto-detect the most recently downloaded LinkedIn Connections.csv.
 * Walks ~/Downloads recursively, finds every file named Connections.csv,
 * and returns the path of the most recently modified one.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findLatestLinkedInCsv(): string | null {
  const downloads = join(homedir(), "Downloads");
  let best: { path: string; mtime: number } | null = null;

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (
            entry === "Connections.csv" &&
            (!best || stat.mtimeMs > best.mtime)
          ) {
            best = { path: full, mtime: stat.mtimeMs };
          }
        } catch {
          // Permission denied or broken symlink — skip
        }
      }
    } catch {
      // Directory unreadable — skip
    }
  }

  walk(downloads);
  return best?.path ?? null;
}
