/**
 * macOS AppleScript scraper — connects to the user's ALREADY OPEN Chrome tab.
 * No new browser. No login. No Google OAuth issues.
 * Works if the user is already on their LinkedIn connections page.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { createServer } from "http";
import { join } from "path";
import { tmpdir, platform } from "os";

export interface ScrapedConnection {
  submissionId: string;
  name: string;
  firstName: string;
  lastName: string;
  linkedinUrl: string;
  position: string;
  company: string;
  connectedOn: string;
  source: string;
}

function makeId(url: string, name: string): string {
  if (url.includes("/in/")) {
    const slug = url.split("/in/")[1]?.replace(/\/$/, "").split("?")[0];
    if (slug) return `li_${slug}`;
  }
  return `li_${name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`;
}

function runAppleScript(script: string): string {
  return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024, // 50MB for large pages
  }).trim();
}

function runAppleScriptFile(script: string): string {
  const tmp = join(tmpdir(), `linkedin-clay-${Date.now()}.scpt`);
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

/** Find the Chrome tab that has LinkedIn connections open */
function findLinkedInTab(): { windowIndex: number; tabIndex: number } | null {
  // First try: check if the active tab of the front window is the connections page
  try {
    const activeUrl = execSync(
      `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    ).trim();

    if (activeUrl.includes("linkedin.com/mynetwork/invite-connect/connections")) {
      // Get the active tab index
      const tabIdx = parseInt(
        execSync(
          `osascript -e 'tell application "Google Chrome" to get active tab index of front window'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim()
      );
      return { windowIndex: 1, tabIndex: isNaN(tabIdx) ? 1 : tabIdx };
    }
  } catch {}

  // Second try: scan all windows/tabs
  try {
    const winCount = parseInt(
      execSync(`osascript -e 'tell application "Google Chrome" to count windows'`, {
        encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
      }).trim()
    );

    for (let w = 1; w <= winCount; w++) {
      const tabCount = parseInt(
        execSync(
          `osascript -e 'tell application "Google Chrome" to count tabs of window ${w}'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim()
      );
      for (let t = 1; t <= tabCount; t++) {
        const url = execSync(
          `osascript -e 'tell application "Google Chrome" to get URL of tab ${t} of window ${w}'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim();
        if (url.includes("linkedin.com/mynetwork/invite-connect/connections")) {
          return { windowIndex: w, tabIndex: t };
        }
      }
    }
  } catch {}

  return null;
}

/** Execute JS in a specific Chrome tab via AppleScript */
function executeJS(windowIndex: number, tabIndex: number, js: string): string {
  const escaped = js.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const script = `
tell application "Google Chrome"
  set theTab to tab ${tabIndex} of window ${windowIndex}
  execute theTab javascript "${escaped}"
end tell
  `;
  return runAppleScriptFile(script);
}

/** Scroll the LinkedIn connections page all the way down */
async function scrollToLoadAll(
  windowIndex: number,
  tabIndex: number,
  onProgress: (count: number) => void
): Promise<void> {
  let lastCount = 0;
  let noNewRounds = 0;

  while (noNewRounds < 4) {
    // Count unique /in/ profile links as a proxy for loaded connections
    const countStr = executeJS(
      windowIndex,
      tabIndex,
      `(function(){ var s={}; document.querySelectorAll("a[href*='/in/']").forEach(function(a){if(a.href)s[a.href.split('?')[0]]=1;}); return Object.keys(s).length; })()`
    );
    const count = parseInt(countStr) || 0;
    onProgress(count);

    if (count === lastCount) {
      noNewRounds++;
    } else {
      lastCount = count;
      noNewRounds = 0;
    }

    // Scroll to bottom to trigger infinite scroll
    executeJS(windowIndex, tabIndex, "window.scrollTo(0, document.body.scrollHeight)");

    // Click "Show more" if present
    executeJS(
      windowIndex,
      tabIndex,
      `(function(){
        var btn = Array.from(document.querySelectorAll("button")).find(b => /show more|load more/i.test(b.textContent));
        if (btn) btn.click();
      })()`
    );

    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Extract all connection data via localStorage (bypasses CSP) */
async function extractConnections(windowIndex: number, tabIndex: number): Promise<ScrapedConnection[]> {
  // Step 1: run extraction JS in Chrome, store result in localStorage
  const extractJs = `
(function() {
  var seen = {};
  var results = [];
  document.querySelectorAll("a[href*='/in/']").forEach(function(a) {
    var url = a.href ? a.href.split("?")[0] : "";
    if (!url || seen[url]) return;
    var label = (a.getAttribute("aria-label") || "").trim();
    var text = (a.innerText || "").trim();
    var raw = label || text;
    if (!raw || raw.length < 2) return;
    var parts = raw.split(/\\n\\n+/);
    var name = parts[0].trim();
    var occ = (parts[1] || "").trim();
    if (!name || name.length < 2) return;
    var position = occ, company = "";
    var atIdx = occ.lastIndexOf(" at ");
    if (atIdx !== -1) { position = occ.slice(0, atIdx).trim(); company = occ.slice(atIdx + 4).trim(); }
    var parent = a.parentElement;
    var timeEl = null;
    for (var i = 0; i < 6 && parent; i++) { timeEl = parent.querySelector("time"); if (timeEl) break; parent = parent.parentElement; }
    seen[url] = true;
    results.push({ url: url, name: name, position: position, company: company, connectedOn: timeEl ? (timeEl.getAttribute("datetime") || "") : "" });
  });
  localStorage.setItem("__lcs_connections__", JSON.stringify(results));
  return results.length;
})()`;

  const countStr = executeJS(windowIndex, tabIndex, extractJs);
  console.log(`  Stored ${countStr} connections in localStorage...`);

  // Step 2: read it back in chunks (localStorage values can be large but AppleScript has limits)
  // Split by reading total length first, then chunking
  const totalStr = executeJS(
    windowIndex, tabIndex,
    `localStorage.getItem("__lcs_connections__") ? localStorage.getItem("__lcs_connections__").length : 0`
  );
  const total = parseInt(totalStr) || 0;

  const CHUNK = 200_000; // 200KB per read
  let json = "";
  for (let offset = 0; offset < total; offset += CHUNK) {
    const chunk = executeJS(
      windowIndex, tabIndex,
      `localStorage.getItem("__lcs_connections__").slice(${offset}, ${offset + CHUNK})`
    );
    json += chunk;
  }

  // Clean up
  executeJS(windowIndex, tabIndex, `localStorage.removeItem("__lcs_connections__")`);

  const items = JSON.parse(json) as Array<{
    url: string; name: string; position: string; company: string; connectedOn: string;
  }>;

  return items.map((item) => {
    const [firstName = "", ...rest] = item.name.split(" ");
    return {
      submissionId: makeId(item.url, item.name),
      name: item.name,
      firstName,
      lastName: rest.join(" "),
      linkedinUrl: item.url,
      position: item.position,
      company: item.company,
      connectedOn: item.connectedOn,
      source: "linkedin_applescript",
    };
  });
}

export async function scrapeViaAppleScript(opts: {
  onProgress?: (scraped: number, pushed: number, name: string) => void;
}): Promise<ScrapedConnection[]> {
  if (platform() !== "darwin") {
    throw new Error("AppleScript mode only works on macOS. Use --playwright mode on other platforms.");
  }

  // Find the LinkedIn connections tab
  const tab = findLinkedInTab();
  if (!tab) {
    throw new Error(
      "\n\n❌ No LinkedIn connections tab found in Chrome.\n" +
      "   Open this URL in Chrome first:\n" +
      "   https://www.linkedin.com/mynetwork/invite-connect/connections/\n" +
      "   Then run this command again.\n"
    );
  }

  console.log(`✓ Found LinkedIn connections tab (window ${tab.windowIndex}, tab ${tab.tabIndex})\n`);
  console.log("Scrolling to load all connections...");

  let visible = 0;
  await scrollToLoadAll(tab.windowIndex, tab.tabIndex, (count) => {
    if (count !== visible) {
      visible = count;
      process.stdout.write(`\r  ${count} connections loaded...`);
    }
  });

  process.stdout.write("\n");
  console.log(`\nExtracting ${visible} connections...`);

  const connections = await extractConnections(tab.windowIndex, tab.tabIndex);
  console.log(`✓ Extracted ${connections.length} connections\n`);

  return connections;
}
