#!/usr/bin/env bun
/**
 * D1 Networking Automation — unified CLI
 *
 * Commands:
 *   imessage  Full iMessage agent (scan, run, inbox, digest, chat, answer, send, skip)
 *   sync      Sync any combination of sources to Clay
 *
 * Examples:
 *   bun src/cli.ts imessage --mode scan
 *   bun src/cli.ts imessage --mode run --dry-run
 *   bun src/cli.ts sync --sources linkedin --csv ~/Downloads/Connections.csv
 *   bun src/cli.ts sync --sources imessage
 *   bun src/cli.ts sync --sources contacts
 *   bun src/cli.ts sync --sources linkedin,imessage,contacts
 *   bun src/cli.ts sync --sources all --dry-run
 */

// Load .env automatically
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// ── sync: unified source sync to Clay ────────────────────────────────────────

if (command === "sync" || !command) {
  const { Command } = await import("commander");
  const chalk = (await import("chalk")).default;
  const ora = (await import("ora")).default;
  const { platform } = await import("node:os");
  const { resolve: pathResolve } = await import("node:path");

  const { mergeRecords } = await import("./core/merge.js");
  const { postToClay } = await import("./core/clay.js");
  const { loadConfig, saveConfig } = await import("./core/config.js");

  const program = new Command();

  program
    .name("d1 sync")
    .description("Sync LinkedIn, iMessage, and iOS Contacts to Clay")
    .option(
      "--sources <list>",
      'Comma-separated sources: linkedin, imessage, contacts, or "all"',
      "all",
    )
    .option(
      "--csv <path>",
      "Path to LinkedIn Connections.csv (linkedin source)",
    )
    .option(
      "--webhook <url>",
      "Clay webhook URL (or set CLAY_WEBHOOK_URL env var)",
    )
    .option("--all", "Re-sync everyone, not just new contacts")
    .option("--dry-run", "Parse all sources without posting to Clay")
    .option("--verbose", "Show every record name as it is processed")
    .parse(["bun", "sync", ...rest]);

  const opts = program.opts<{
    sources: string;
    csv?: string;
    webhook?: string;
    all?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
  }>();

  const rawSources =
    opts.sources === "all"
      ? ["linkedin", "imessage", "contacts"]
      : opts.sources.split(",").map((s) => s.trim().toLowerCase());

  const config = loadConfig();
  const webhookUrl =
    opts.webhook ?? config.clayWebhookUrl ?? process.env.CLAY_WEBHOOK_URL ?? "";

  if (!webhookUrl && !opts.dryRun) {
    console.error(
      chalk.red(
        "No Clay webhook URL. Pass --webhook <url> or set CLAY_WEBHOOK_URL in .env",
      ),
    );
    process.exit(1);
  }

  const batches: Awaited<ReturnType<typeof mergeRecords>> extends (infer T)[]
    ? T[][]
    : never[] = [] as any;

  // ── LinkedIn ────────────────────────────────────────────────────────────────

  if (rawSources.includes("linkedin")) {
    const spinner = ora("LinkedIn: loading connections...").start();
    try {
      const { linkedInToRecords } = await import("./linkedin/adapter.js");

      if (opts.csv) {
        const { parseLinkedInCsv } = await import("./linkedin/parse.js");
        const csvPath = pathResolve(
          opts.csv.replace(/^~/, process.env.HOME ?? ""),
        );
        if (!existsSync(csvPath)) {
          spinner.fail(`LinkedIn CSV not found: ${csvPath}`);
          process.exit(1);
        }
        const connections = await parseLinkedInCsv(csvPath);
        const records = linkedInToRecords(connections);
        batches.push(records as any);
        spinner.succeed(`LinkedIn: ${records.length} connections from CSV`);
      } else if (platform() === "darwin") {
        const { scrapeViaAppleScript } =
          await import("./linkedin/scraper-applescript.js");
        spinner.info(
          "LinkedIn: connecting to Chrome... (make sure linkedin.com/mynetwork/invite-connect/connections/ is open)",
        );
        const connections = await scrapeViaAppleScript({
          onProgress: () => {},
        });
        const records = linkedInToRecords(connections);
        batches.push(records as any);
        spinner.succeed(`LinkedIn: ${records.length} connections scraped`);
      } else {
        const { scrapeConnections } = await import("./linkedin/scraper.js");
        const connections = await scrapeConnections({ onProgress: () => {} });
        const records = linkedInToRecords(connections);
        batches.push(records as any);
        spinner.succeed(`LinkedIn: ${records.length} connections scraped`);
      }
    } catch (err: unknown) {
      spinner.fail(`LinkedIn failed: ${(err as Error).message}`);
    }
  }

  // ── iMessage ────────────────────────────────────────────────────────────────

  if (rawSources.includes("imessage")) {
    const spinner = ora("iMessage: reading chat.db...").start();
    try {
      const { readIMessageContacts } =
        await import("./imessage/clay-export.js");
      const records = readIMessageContacts();
      batches.push(records as any);
      spinner.succeed(`iMessage: ${records.length} contacts`);
    } catch (err: unknown) {
      spinner.fail(`iMessage failed: ${(err as Error).message}`);
    }
  }

  // ── iOS Contacts ─────────────────────────────────────────────────────────────

  if (rawSources.includes("contacts")) {
    const spinner = ora("Contacts: reading AddressBook...").start();
    try {
      const { readContacts } = await import("./contacts/reader.js");
      const records = readContacts();
      batches.push(records as any);
      spinner.succeed(`Contacts: ${records.length} contacts`);
    } catch (err: unknown) {
      spinner.fail(`Contacts failed: ${(err as Error).message}`);
    }
  }

  if (batches.length === 0) {
    console.log(
      chalk.yellow("No records found. Check your sources and try again."),
    );
    process.exit(0);
  }

  // ── Merge ────────────────────────────────────────────────────────────────────

  const mergeSpinner = ora("Merging and deduplicating...").start();
  const merged = mergeRecords(batches as any);
  mergeSpinner.succeed(`Merged: ${merged.length} unique people`);

  const multiSource = merged.filter((r) => r.sources.length > 1);
  if (multiSource.length > 0) {
    console.log(
      chalk.dim(`  ${multiSource.length} appear in multiple sources`),
    );
  }

  if (opts.dryRun) {
    console.log(chalk.yellow("\nDry run — not posting to Clay\n"));
    const alreadySynced = new Set(config.syncedIds);
    const newCount = merged.filter(
      (r) => !alreadySynced.has(r.submission_id),
    ).length;
    console.log(`  ${newCount} new people would be added to Clay`);
    console.log(`  ${merged.length - newCount} already synced`);
    if (opts.verbose) {
      for (const r of merged.slice(0, 20)) {
        console.log(
          chalk.dim(
            `  [${r.sources.join(",")}] ${r.name} (${r.phone ?? r.email ?? r.linkedin_url ?? "?"})`,
          ),
        );
      }
      if (merged.length > 20)
        console.log(chalk.dim(`  ... and ${merged.length - 20} more`));
    }
    process.exit(0);
  }

  // ── Post to Clay ─────────────────────────────────────────────────────────────

  const alreadySynced = opts.all
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
      if (opts.verbose || status === "failed") {
        const icon =
          status === "sent"
            ? chalk.green("✓")
            : status === "skipped"
              ? chalk.dim("-")
              : chalk.red("✗");
        process.stdout.write(
          `\r${icon} [${i}/${toPost.length}] ${name.padEnd(40)}`,
        );
      } else {
        process.stdout.write(`\r  [${i}/${toPost.length}] ${name.padEnd(40)}`);
      }
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

console.error(`Unknown command: ${command}`);
console.error("Usage: bun src/cli.ts [imessage|sync] [options]");
process.exit(1);
