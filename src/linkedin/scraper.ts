import { chromium } from "playwright";
import { join } from "path";
import { homedir } from "os";

// Persistent browser profile — stores login session between runs
const USER_DATA_DIR = join(homedir(), ".linkedin-clay-sync-browser");

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

function parseConnections(nodes: Element[]): Array<{
  url: string; name: string; position: string; company: string; connectedOn: string;
}> {
  return nodes.map((node) => {
    const anchor = node.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
    const nameEl = node.querySelector(".mn-connection-card__name, [class*='connection-card__name']");
    const occupationEl = node.querySelector(".mn-connection-card__occupation, [class*='connection-card__occupation']");
    const timeEl = node.querySelector("time, .mn-connection-card__connected-date");

    const url = anchor?.href?.split("?")[0] ?? "";
    const name = nameEl?.textContent?.trim() ?? "";
    const occupation = occupationEl?.textContent?.trim() ?? "";

    let position = occupation;
    let company = "";
    const atIdx = occupation.lastIndexOf(" at ");
    if (atIdx !== -1) {
      position = occupation.slice(0, atIdx).trim();
      company = occupation.slice(atIdx + 4).trim();
    }

    return { url, name, position, company, connectedOn: timeEl?.getAttribute("datetime") ?? "" };
  });
}

async function waitForLogin(page: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["pages"][0]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const url = page.url();
      if (!url.includes("/login") && !url.includes("/checkpoint") && !url.includes("/authwall") && url.includes("linkedin.com")) {
        return;
      }
      await page.waitForTimeout(1000);
    } catch {
      throw new Error(
        "\n\n❌ The browser window was closed before login completed.\n" +
        "   Please run the command again and:\n" +
        "   1. Sign into LinkedIn in the window that opens\n" +
        "   2. Leave that window open until the terminal says 'Done'\n"
      );
    }
  }
  throw new Error("Login timed out. Please run again and sign in within 2 minutes.");
}

export async function scrapeConnections(opts: {
  onProgress?: (count: number, name: string) => void;
}): Promise<ScrapedConnection[]> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  const connections: ScrapedConnection[] = [];

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // Navigate to connections page
    await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Handle login if needed
    const url = page.url();
    if (url.includes("/login") || url.includes("/checkpoint") || url.includes("/authwall")) {
      // Inject a banner so user knows to stay on this window
      await page.evaluate(() => {
        const b = document.createElement("div");
        b.textContent = "⚡ linkedin-clay-sync — sign in, then leave this window open";
        Object.assign(b.style, {
          position: "fixed", top: "0", left: "0", right: "0", zIndex: "9999999",
          background: "#0077b5", color: "#fff", textAlign: "center",
          padding: "12px", fontFamily: "sans-serif", fontSize: "14px", fontWeight: "bold",
        });
        document.body?.prepend(b);
      }).catch(() => {});

      console.log("\n🔐 Sign into LinkedIn in the browser window — then leave it open.");
      console.log("   (Session will be saved — future runs are automatic)\n");

      await waitForLogin(page);
      console.log("✓ Logged in!\n");

      await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } else {
      console.log("✓ Using saved session\n");
    }

    // Wait for first batch of connection cards
    await page.waitForSelector("li.mn-connection-card, li[class*='connection-card']", {
      timeout: 15_000,
    }).catch(() => console.warn("⚠ Connection cards not found — LinkedIn may have changed its layout"));

    // Auto-scroll to load ALL connections
    const seen = new Set<string>();
    let consecutiveNoNew = 0;

    while (consecutiveNoNew < 4) {
      // Extract all currently visible connections
      const raw = await page.$$eval(
        "li.mn-connection-card, li[class*='connection-card']",
        (nodes) => nodes.map((node) => {
          const anchor = node.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
          const nameEl = node.querySelector(".mn-connection-card__name, [class*='connection-card__name']");
          const occupationEl = node.querySelector(".mn-connection-card__occupation, [class*='connection-card__occupation']");
          const timeEl = node.querySelector("time, .mn-connection-card__connected-date");

          const url = anchor?.href?.split("?")[0] ?? "";
          const name = nameEl?.textContent?.trim() ?? "";
          const occupation = occupationEl?.textContent?.trim() ?? "";

          let position = occupation;
          let company = "";
          const atIdx = occupation.lastIndexOf(" at ");
          if (atIdx !== -1) {
            position = occupation.slice(0, atIdx).trim();
            company = occupation.slice(atIdx + 4).trim();
          }

          return { url, name, position, company, connectedOn: timeEl?.getAttribute("datetime") ?? "" };
        })
      );

      let newThisRound = 0;
      for (const item of raw) {
        if (!item.name || !item.url) continue;
        const id = makeId(item.url, item.name);
        if (seen.has(id)) continue;
        seen.add(id);

        const [firstName = "", ...rest] = item.name.split(" ");
        connections.push({
          submissionId: id,
          name: item.name,
          firstName,
          lastName: rest.join(" "),
          linkedinUrl: item.url,
          position: item.position,
          company: item.company,
          connectedOn: item.connectedOn,
          source: "linkedin_scrape",
        });
        opts.onProgress?.(connections.length, item.name);
        newThisRound++;
      }

      if (newThisRound === 0) {
        consecutiveNoNew++;
      } else {
        consecutiveNoNew = 0;
      }

      // Scroll to absolute bottom to trigger LinkedIn's infinite scroll
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);

      // Also try clicking "Show more" if present
      const showMore = page.locator("button:has-text('Show more'), button:has-text('Load more')").first();
      if (await showMore.isVisible().catch(() => false)) {
        await showMore.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
  } finally {
    await context.close();
  }

  return connections;
}
