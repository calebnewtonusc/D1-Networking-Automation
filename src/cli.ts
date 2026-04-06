#!/usr/bin/env bun
/**
 * D1 Networking Automation — unified CLI
 *
 * Commands:
 *   imessage  Full iMessage agent (scan, run, inbox, digest, chat, answer, send, skip)
 *   sync      Sync any combination of sources to Clay
 *   dedup     Remove duplicate rows from your Clay table (macOS, requires Clay open in Chrome)
 *
 * Examples:
 *   bun src/cli.ts imessage --mode scan
 *   bun src/cli.ts imessage --mode run --dry-run
 *   bun src/cli.ts sync --sources all
 *   bun src/cli.ts sync --sources linkedin                          (auto-finds Connections.csv in Downloads)
 *   bun src/cli.ts sync --sources linkedin --csv ~/Downloads/Connections.csv
 *   bun src/cli.ts sync --sources imessage
 *   bun src/cli.ts sync --sources contacts
 *   bun src/cli.ts sync --sources linkedin,imessage,contacts --dry-run
 *   bun src/cli.ts dedup
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";

// Load .env automatically
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
}

const [, , command, ...rest] = process.argv;

// ── imessage: delegate entirely to the agent ──────────────────────────────────

if (command === "imessage" || command === "agent") {
  process.argv = [process.argv[0], process.argv[1], ...rest];
  await import("./imessage/agent.js");
  process.exit(0);
}

// ── dedup: remove duplicate rows from Clay table ──────────────────────────────

if (command === "dedup") {
  const chalk = (await import("chalk")).default;

  if (platform() !== "darwin") {
    console.error(
      chalk.red(
        "dedup requires macOS (uses AppleScript to interact with Clay in Chrome).",
      ),
    );
    process.exit(1);
  }

  const args = rest;
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (f: string) => args.includes(f);

  const tableNameHint = getFlag("--table-name") ?? "linkedin";
  const workspaceId = parseInt(getFlag("--workspace-id") ?? "227550");
  const dryRun = hasFlag("--dry-run");

  console.log(chalk.cyan("\nConnecting to Clay in Chrome...\n"));
  console.log(
    chalk.dim("Make sure you are logged in to Clay at app.clay.com\n"),
  );

  const { dedupClayTable } = await import("./core/dedup-clay.js");

  try {
    const result = await dedupClayTable({
      workspaceId,
      tableNameHint,
      onProgress: (msg) => console.log(chalk.dim(msg)),
    });

    if (dryRun) {
      console.log(
        chalk.yellow(
          `\nDry run — ${result.duplicatesRemoved} duplicate rows found`,
        ),
      );
      console.log(
        chalk.dim(`Table: ${result.tableId}, Total rows: ${result.totalRows}`),
      );
    } else if (result.duplicatesRemoved === 0) {
      console.log(chalk.green("\nNo duplicates found — Clay table is clean"));
    } else {
      console.log(
        chalk.green(`\nRemoved ${result.duplicatesRemoved} duplicate rows`),
      );
      console.log(chalk.dim(`  Table: ${result.tableId}`));
      console.log(
        chalk.dim(
          `  Remaining rows: ${result.totalRows - result.duplicatesRemoved}`,
        ),
      );
    }

    if (result.errors.length > 0) {
      console.log(chalk.red(`\n${result.errors.length} errors:`));
      result.errors.forEach((e) => console.log(chalk.dim(`  ${e}`)));
    }
  } catch (err: unknown) {
    console.error(chalk.red("\nDedup failed:"), (err as Error).message);
    process.exit(1);
  }

  process.exit(0);
}

// ── sync: unified source sync to Clay ────────────────────────────────────────

if (command === "sync" || !command) {
  const chalk = (await import("chalk")).default;
  const ora = (await import("ora")).default;

  const args = rest;
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (f: string) => args.includes(f);

  const sourcesRaw = getFlag("--sources") ?? "all";
  const csvFlag = getFlag("--csv");
  const webhookFlag = getFlag("--webhook");
  const resyncAll = hasFlag("--all");
  const dryRun = hasFlag("--dry-run");
  const verbose = hasFlag("--verbose");

  const sources =
    sourcesRaw === "all"
      ? ["linkedin", "imessage", "contacts"]
      : sourcesRaw.split(",").map((s) => s.trim().toLowerCase());

  const { mergeRecords } = await import("./core/merge.js");
  const { postToClay } = await import("./core/clay.js");
  const { loadConfig, saveConfig } = await import("./core/config.js");

  const config = loadConfig();
  const webhookUrl =
    webhookFlag ?? config.clayWebhookUrl ?? process.env.CLAY_WEBHOOK_URL ?? "";

  if (!webhookUrl && !dryRun) {
    console.error(
      chalk.red(
        "No Clay webhook URL. Pass --webhook <url> or set CLAY_WEBHOOK_URL in .env",
      ),
    );
    process.exit(1);
  }

  // Import the PersonRecord type for proper typing
  type PR = import("./core/types.js").PersonRecord;
  const batches: PR[][] = [];

  // ── LinkedIn ────────────────────────────────────────────────────────────────

  if (sources.includes("linkedin")) {
    const spinner = ora("LinkedIn: loading connections...").start();
    try {
      const { linkedInToRecords } = await import("./linkedin/adapter.js");
      const { findLatestLinkedInCsv } = await import("./linkedin/finder.js");

      let csvPath: string | null = csvFlag
        ? resolve(csvFlag.replace(/^~/, process.env.HOME ?? ""))
        : null;

      if (!csvPath) {
        csvPath = findLatestLinkedInCsv();
        if (csvPath)
          spinner.text = `LinkedIn: found ${csvPath.split("/").pop()} in Downloads`;
      }

      if (csvPath && existsSync(csvPath)) {
        const { parseLinkedInCsv } = await import("./linkedin/parse.js");
        const connections = await parseLinkedInCsv(csvPath);
        const records = linkedInToRecords(connections);
        batches.push(records);
        spinner.succeed(`LinkedIn: ${records.length} connections from CSV`);
      } else if (platform() === "darwin") {
        const { scrapeViaAppleScript } =
          await import("./linkedin/scraper-applescript.js");
        spinner.info("LinkedIn: no CSV found — connecting to Chrome scraper");
        spinner.info(
          "  Open linkedin.com/mynetwork/invite-connect/connections/ in Chrome first",
        );
        const connections = await scrapeViaAppleScript({
          onProgress: () => {},
        });
        const records = linkedInToRecords(connections);
        batches.push(records);
        spinner.succeed(
          `LinkedIn: ${records.length} connections scraped from Chrome`,
        );
      } else {
        const { scrapeConnections } = await import("./linkedin/scraper.js");
        const connections = await scrapeConnections({ onProgress: () => {} });
        const records = linkedInToRecords(connections);
        batches.push(records);
        spinner.succeed(`LinkedIn: ${records.length} connections scraped`);
      }
    } catch (err: unknown) {
      spinner.fail(`LinkedIn failed: ${(err as Error).message}`);
    }
  }

  // ── iMessage ────────────────────────────────────────────────────────────────

  if (sources.includes("imessage")) {
    const spinner = ora("iMessage: reading chat.db...").start();
    try {
      const { readIMessageContacts } =
        await import("./imessage/clay-export.js");
      const records = readIMessageContacts();
      batches.push(records);
      spinner.succeed(`iMessage: ${records.length} contacts`);
    } catch (err: unknown) {
      spinner.fail(`iMessage failed: ${(err as Error).message}`);
    }
  }

  // ── iOS Contacts ─────────────────────────────────────────────────────────────

  if (sources.includes("contacts")) {
    const spinner = ora("Contacts: reading AddressBook...").start();
    try {
      const { readContacts } = await import("./contacts/reader.js");
      const records = readContacts();
      batches.push(records);
      spinner.succeed(`Contacts: ${records.length} contacts`);
    } catch (err: unknown) {
      spinner.fail(`Contacts failed: ${(err as Error).message}`);
    }
  }

  if (batches.length === 0) {
    console.log(
      chalk.yellow("\nNo records found. Check your sources and try again."),
    );
    process.exit(0);
  }

  // ── Merge + dedup ─────────────────────────────────────────────────────────────

  const mergeSpinner = ora("Merging and deduplicating...").start();
  const merged = mergeRecords(batches);
  mergeSpinner.succeed(`Merged: ${merged.length} unique people`);

  const multiSource = merged.filter((r) => r.sources.length > 1);
  if (multiSource.length > 0) {
    console.log(
      chalk.dim(`  ${multiSource.length} appear in multiple sources`),
    );
  }

  // ── Dry run ────────────────────────────────────────────────────────────────

  if (dryRun) {
    const alreadySynced = new Set(config.syncedIds);
    const newCount = merged.filter(
      (r) => !alreadySynced.has(r.submission_id),
    ).length;
    console.log(chalk.yellow("\nDry run — not posting to Clay"));
    console.log(`  ${newCount} new people would be added`);
    console.log(`  ${merged.length - newCount} already synced`);
    if (verbose) {
      for (const r of merged.slice(0, 30)) {
        console.log(
          chalk.dim(
            `  [${r.sources.join(",")}] ${r.name} (${r.phone ?? r.email ?? r.linkedin_url ?? "?"})`,
          ),
        );
      }
      if (merged.length > 30)
        console.log(chalk.dim(`  ... and ${merged.length - 30} more`));
    }
    process.exit(0);
  }

  // ── Post to Clay ─────────────────────────────────────────────────────────────

  const alreadySynced = resyncAll
    ? new Set<string>()
    : new Set(config.syncedIds);
  const toPost = merged.filter((r) => !alreadySynced.has(r.submission_id));

  if (toPost.length === 0) {
    console.log(
      chalk.green("\nAll contacts already synced — nothing new to send"),
    );
    process.exit(0);
  }

  console.log(chalk.cyan(`\nPosting ${toPost.length} people to Clay...\n`));

  let i = 0;
  const result = await postToClay(
    toPost,
    webhookUrl,
    alreadySynced,
    (name, status) => {
      i++;
      const icon =
        status === "sent"
          ? chalk.green("✓")
          : status === "skipped"
            ? chalk.dim("-")
            : chalk.red("✗");
      process.stdout.write(
        `\r${icon} [${i}/${toPost.length}] ${name.padEnd(40)}`,
      );
    },
  );

  process.stdout.write("\n\n");
  console.log(chalk.green(`Sent: ${result.sent}`));
  if (result.skipped > 0)
    console.log(chalk.dim(`Skipped (already synced): ${result.skipped}`));
  if (result.failed.length > 0)
    console.log(chalk.red(`Failed: ${result.failed.length}`));

  config.syncedIds = Array.from(alreadySynced);
  config.lastSyncedAt = new Date().toISOString();
  if (webhookUrl) config.clayWebhookUrl = webhookUrl;
  saveConfig(config);

  console.log(chalk.dim(`\nState saved to ~/.d1-networking.json`));
  process.exit(0);
}

// ── Unknown command ────────────────────────────────────────────────────────────

console.error(`Unknown command: ${command ?? "(none)"}`);
console.error("");
console.error("Usage:");
console.error("  bun src/cli.ts imessage --mode scan");
console.error("  bun src/cli.ts imessage --mode run");
console.error("  bun src/cli.ts sync --sources all");
console.error("  bun src/cli.ts sync --sources linkedin,imessage,contacts");
console.error("  bun src/cli.ts dedup");
process.exit(1);
