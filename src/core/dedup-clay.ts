/**
 * Clay table deduplication via in-browser API calls.
 *
 * Finds the Clay tab already open in Chrome and executes fetch() calls through
 * the browser's existing authenticated session — no cookie extraction needed.
 *
 * Finds all rows in the LinkedIn Connections table, identifies duplicates by
 * submission_id (or linkedin_url as fallback), and deletes the extras.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";

function runAppleScriptFile(script: string): string {
  const tmp = join(tmpdir(), `clay-dedup-${Date.now()}.scpt`);
  writeFileSync(tmp, script);
  try {
    return execSync(`osascript ${tmp}`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
  } finally {
    unlinkSync(tmp);
  }
}

function executeJSInTab(
  windowIndex: number,
  tabIndex: number,
  js: string,
): string {
  const escaped = js
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
  const script = `
tell application "Google Chrome"
  set theTab to tab ${tabIndex} of window ${windowIndex}
  execute theTab javascript "${escaped}"
end tell
  `;
  return runAppleScriptFile(script);
}

function findClayTab(): { windowIndex: number; tabIndex: number } | null {
  // Check active tab first
  try {
    const activeUrl = execSync(
      `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    ).trim();

    if (activeUrl.includes("app.clay.com") || activeUrl.includes("clay.com")) {
      const tabIdx = parseInt(
        execSync(
          `osascript -e 'tell application "Google Chrome" to get active tab index of front window'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
        ).trim(),
      );
      return { windowIndex: 1, tabIndex: isNaN(tabIdx) ? 1 : tabIdx };
    }
  } catch {}

  // Scan all windows/tabs
  try {
    const winCount = parseInt(
      execSync(
        `osascript -e 'tell application "Google Chrome" to count windows'`,
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        },
      ).trim(),
    );

    for (let w = 1; w <= winCount; w++) {
      const tabCount = parseInt(
        execSync(
          `osascript -e 'tell application "Google Chrome" to count tabs of window ${w}'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
        ).trim(),
      );
      for (let t = 1; t <= tabCount; t++) {
        const url = execSync(
          `osascript -e 'tell application "Google Chrome" to get URL of tab ${t} of window ${w}'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
        ).trim();
        if (
          url.includes("app.clay.com") ||
          url.includes("clay.com/workspaces")
        ) {
          return { windowIndex: w, tabIndex: t };
        }
      }
    }
  } catch {}

  return null;
}

/** Open Clay in Chrome and wait for it to load */
async function openClayInChrome(
  workspaceId: number,
): Promise<{ windowIndex: number; tabIndex: number }> {
  execSync(
    `osascript -e 'tell application "Google Chrome" to open location "https://app.clay.com/workspaces/${workspaceId}"'`,
    { encoding: "utf-8" },
  );
  // Wait for page to load
  await new Promise((r) => setTimeout(r, 3000));

  const tab = findClayTab();
  if (!tab) throw new Error("Could not find Clay tab after opening");
  return tab;
}

/** Run a fetch() inside the Clay Chrome tab and return parsed JSON */
async function clayApiFetch(
  windowIndex: number,
  tabIndex: number,
  endpoint: string,
  options: { method?: string } = {},
): Promise<unknown> {
  const method = options.method ?? "GET";
  const js = `
(async () => {
  try {
    const res = await fetch("https://api.clay.com${endpoint}", {
      method: "${method}",
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    });
    const text = await res.text();
    localStorage.setItem("__clay_api_result__", JSON.stringify({ status: res.status, body: text }));
    return res.status;
  } catch (e) {
    localStorage.setItem("__clay_api_result__", JSON.stringify({ status: 0, body: e.message }));
    return 0;
  }
})()
  `;

  executeJSInTab(windowIndex, tabIndex, js);
  // Wait for async fetch to complete
  await new Promise((r) => setTimeout(r, 1500));

  // Read result from localStorage in chunks
  const lenStr = executeJSInTab(
    windowIndex,
    tabIndex,
    `localStorage.getItem("__clay_api_result__") ? localStorage.getItem("__clay_api_result__").length : 0`,
  );
  const len = parseInt(lenStr) || 0;

  const CHUNK = 200_000;
  let raw = "";
  for (let offset = 0; offset < len; offset += CHUNK) {
    raw += executeJSInTab(
      windowIndex,
      tabIndex,
      `localStorage.getItem("__clay_api_result__").slice(${offset}, ${offset + CHUNK})`,
    );
  }

  executeJSInTab(
    windowIndex,
    tabIndex,
    `localStorage.removeItem("__clay_api_result__")`,
  );

  const result = JSON.parse(raw) as { status: number; body: string };
  if (result.status === 0)
    throw new Error(`Clay API request failed: ${result.body}`);
  return JSON.parse(result.body);
}

export interface DedupResult {
  tableId: string;
  totalRows: number;
  duplicatesRemoved: number;
  errors: string[];
}

export async function dedupClayTable(opts: {
  workspaceId?: number;
  tableNameHint?: string;
  onProgress?: (msg: string) => void;
}): Promise<DedupResult> {
  if (platform() !== "darwin") {
    throw new Error("Clay dedup via AppleScript only works on macOS.");
  }

  const workspaceId = opts.workspaceId ?? 227550;
  const log = opts.onProgress ?? ((msg: string) => console.log(msg));

  // Find or open Clay tab
  log("Looking for Clay tab in Chrome...");
  let tab = findClayTab();
  if (!tab) {
    log("  Clay not open — opening app.clay.com...");
    tab = await openClayInChrome(workspaceId);
    log("  Clay opened.");
  } else {
    log(`  Found Clay tab (window ${tab.windowIndex}, tab ${tab.tabIndex})`);
  }

  const { windowIndex, tabIndex } = tab;

  // Step 1: List all tables in workspace
  log("Fetching Clay tables...");
  const tablesData = (await clayApiFetch(
    windowIndex,
    tabIndex,
    `/v3/tables?workspaceId=${workspaceId}&limit=50`,
  )) as {
    items?: Array<{ id: string; name: string }>;
  };

  if (!tablesData.items?.length) {
    throw new Error(
      `No tables found. Raw response: ${JSON.stringify(tablesData).slice(0, 500)}`,
    );
  }

  log(
    `  Found ${tablesData.items.length} tables: ${tablesData.items.map((t) => t.name).join(", ")}`,
  );

  // Step 2: Find the LinkedIn Connections table
  const hint = opts.tableNameHint?.toLowerCase() ?? "linkedin";
  const table = tablesData.items.find(
    (t) =>
      t.name.toLowerCase().includes(hint) ||
      t.name.toLowerCase().includes("connection"),
  );

  if (!table) {
    throw new Error(
      `Could not find a table matching "${hint}" in your Clay workspace.\n` +
        `Available tables: ${tablesData.items.map((t) => t.name).join(", ")}\n` +
        `Pass --table-name <name> to specify which table to dedup.`,
    );
  }

  log(`  Target table: "${table.name}" (${table.id})`);

  // Step 3: Get all rows, paging through with cursor
  log("Fetching all rows...");
  const allRows: Array<{
    id: string;
    fieldValues?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }> = [];
  let nextCursor: string | undefined;

  do {
    const qs = nextCursor
      ? `/v3/tables/${table.id}/rows?limit=100&cursor=${nextCursor}`
      : `/v3/tables/${table.id}/rows?limit=100`;

    const rowsData = (await clayApiFetch(windowIndex, tabIndex, qs)) as {
      items?: Array<{
        id: string;
        fieldValues?: Record<string, unknown>;
        data?: Record<string, unknown>;
      }>;
      nextCursor?: string;
    };

    if (rowsData.items) allRows.push(...rowsData.items);
    nextCursor = rowsData.nextCursor;

    log(`  Loaded ${allRows.length} rows so far...`);
  } while (nextCursor);

  log(`  Total rows: ${allRows.length}`);

  // Step 4: Find duplicates by submission_id or linkedin_url
  const seen = new Map<string, string>(); // key -> first row ID
  const toDelete: string[] = [];

  for (const row of allRows) {
    const fields = row.fieldValues ?? row.data ?? {};

    // Try to get a dedup key — submission_id is best, fall back to linkedin_url
    const submissionId =
      (fields["submission_id"] as string) ?? (fields["submissionId"] as string);
    const linkedinUrl =
      (fields["linkedin_url"] as string) ?? (fields["linkedinUrl"] as string);

    const key = submissionId || linkedinUrl;
    if (!key) continue; // can't dedup without a key

    if (seen.has(key)) {
      toDelete.push(row.id); // duplicate — mark for deletion
    } else {
      seen.set(key, row.id);
    }
  }

  log(`  Found ${toDelete.length} duplicate rows to remove.`);

  if (toDelete.length === 0) {
    return {
      tableId: table.id,
      totalRows: allRows.length,
      duplicatesRemoved: 0,
      errors: [],
    };
  }

  // Step 5: Delete duplicates
  const errors: string[] = [];
  let removed = 0;

  for (const rowId of toDelete) {
    try {
      await clayApiFetch(
        windowIndex,
        tabIndex,
        `/v3/tables/${table.id}/rows/${rowId}`,
        {
          method: "DELETE",
        },
      );
      removed++;
      log(`  Deleted row ${rowId} (${removed}/${toDelete.length})`);
    } catch (err) {
      errors.push(`Failed to delete row ${rowId}: ${err}`);
    }
    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    tableId: table.id,
    totalRows: allRows.length,
    duplicatesRemoved: removed,
    errors,
  };
}
