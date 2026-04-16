#!/usr/bin/env bun
/**
 * D1 Networking Automation — unified CLI
 *
 * Commands:
 *   imessage          Full iMessage agent (scan, run, inbox, digest, chat, answer, send, skip)
 *   sync              Sync LinkedIn/iMessage/Contacts to a registered Clay table
 *   dedup             Remove duplicate rows from Clay table (macOS, Chrome)
 *   tables add        Register a Clay webhook table
 *   tables list       List all registered tables with usage
 *   tables get        Get table details + usage
 *   tables update     Update table config
 *   tables remove     Remove a table
 *   tables reset      Reset row counter + swap webhook URL
 *   fire              Fire a JSON payload to a registered table
 *   listen start      Start callback listener (local + cloudflared tunnel)
 *   listen status     Check listener status
 *   usage             Show row usage for all tables
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";
import { randomUUID } from "node:crypto";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
}

const [, , command, subcommand, ...rest] = process.argv;

// ── imessage ────────────────────────────────────────────────────────────────

if (command === "imessage" || command === "agent") {
  process.argv = [
    process.argv[0],
    process.argv[1],
    ...(subcommand ? [subcommand, ...rest] : rest),
  ];
  await import("./imessage/agent.js");
  process.exit(0);
}

// ── tables ──────────────────────────────────────────────────────────────────

if (command === "tables") {
  const chalk = (await import("chalk")).default;
  const {
    getTable,
    addTable,
    removeTable,
    updateTable,
    loadTables,
    resetUsage,
  } = await import("./core/tables.js");
  const { getTableUsage } = await import("./core/usage.js");

  const args = rest;
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (subcommand === "add") {
    const name = getFlag("--name") ?? getFlag("-n");
    const webhookUrl = getFlag("--webhook-url") ?? getFlag("-w");
    const authKey = getFlag("--auth-key") ?? getFlag("-k");
    const description = getFlag("--description") ?? getFlag("-d");
    const rowLimit = parseInt(getFlag("--row-limit") ?? "50000");

    if (!name || !webhookUrl) {
      console.error(chalk.red("Required: --name <name> --webhook-url <url>"));
      process.exit(1);
    }

    if (getTable(name)) {
      console.error(
        chalk.red(`Table "${name}" already exists. Use "tables update".`),
      );
      process.exit(1);
    }

    addTable({
      name,
      webhookUrl,
      authKey,
      description,
      createdAt: new Date().toISOString(),
      rowLimit,
    });
    console.log(chalk.green(`Added table "${name}"`));
    console.log(chalk.dim(`  Webhook: ${webhookUrl}`));
    console.log(chalk.dim(`  Row limit: ${rowLimit}`));
  } else if (subcommand === "list") {
    const store = loadTables();
    const tables = Object.values(store.tables);
    if (tables.length === 0) {
      console.log(chalk.yellow("No tables registered. Run: tables add"));
      process.exit(0);
    }
    for (const t of tables) {
      const usage = getTableUsage(t.name);
      const pct = Math.round((usage.count / t.rowLimit) * 100);
      console.log(
        chalk.cyan(t.name) +
          chalk.dim(` (${usage.count}/${t.rowLimit} rows, ${pct}%)`),
      );
      console.log(chalk.dim(`  ${t.webhookUrl}`));
      if (t.description) console.log(chalk.dim(`  ${t.description}`));
    }
  } else if (subcommand === "get") {
    const name = args[0];
    if (!name) {
      console.error(chalk.red("Usage: tables get <name>"));
      process.exit(1);
    }
    const table = getTable(name);
    if (!table) {
      console.error(chalk.red(`Table "${name}" not found.`));
      process.exit(1);
    }
    const usage = getTableUsage(name);
    console.log(chalk.cyan(table.name));
    console.log(`  Webhook:     ${table.webhookUrl}`);
    if (table.authKey)
      console.log(`  Auth key:    ${table.authKey.slice(0, 8)}...`);
    if (table.description) console.log(`  Description: ${table.description}`);
    console.log(`  Rows used:   ${usage.count}/${table.rowLimit}`);
    console.log(`  Remaining:   ${table.rowLimit - usage.count}`);
    if (usage.lastFired) console.log(`  Last fired:  ${usage.lastFired}`);
  } else if (subcommand === "update") {
    const name = args[0];
    if (!name) {
      console.error(
        chalk.red(
          "Usage: tables update <name> [--webhook-url] [--auth-key] [--description] [--row-limit]",
        ),
      );
      process.exit(1);
    }
    const updates: Record<string, string | number | undefined> = {};
    const wh = getFlag("--webhook-url") ?? getFlag("-w");
    const ak = getFlag("--auth-key") ?? getFlag("-k");
    const desc = getFlag("--description") ?? getFlag("-d");
    const rl = getFlag("--row-limit");
    if (wh) updates.webhookUrl = wh;
    if (ak) updates.authKey = ak;
    if (desc) updates.description = desc;
    if (rl) updates.rowLimit = parseInt(rl);

    const updated = updateTable(name, updates);
    if (!updated) {
      console.error(chalk.red(`Table "${name}" not found.`));
      process.exit(1);
    }
    console.log(chalk.green(`Updated table "${name}"`));
  } else if (subcommand === "remove") {
    const name = args[0];
    if (!name) {
      console.error(chalk.red("Usage: tables remove <name>"));
      process.exit(1);
    }
    if (!removeTable(name)) {
      console.error(chalk.red(`Table "${name}" not found.`));
      process.exit(1);
    }
    console.log(chalk.green(`Removed table "${name}"`));
  } else if (subcommand === "reset") {
    const name = args[0];
    if (!name) {
      console.error(
        chalk.red("Usage: tables reset <name> --webhook-url <new-url>"),
      );
      process.exit(1);
    }
    const table = getTable(name);
    if (!table) {
      console.error(chalk.red(`Table "${name}" not found.`));
      process.exit(1);
    }
    const newUrl = getFlag("--webhook-url") ?? getFlag("-w");
    if (newUrl) updateTable(name, { webhookUrl: newUrl });
    resetUsage(name, table.rowLimit);
    console.log(chalk.green(`Reset row counter for "${name}" to 0`));
    if (newUrl) console.log(chalk.dim(`  New webhook: ${newUrl}`));
  } else {
    console.error(chalk.red(`Unknown tables command: ${subcommand}`));
    console.error("  add, list, get, update, remove, reset");
    process.exit(1);
  }
  process.exit(0);
}

// ── fire ────────────────────────────────────────────────────────────────────

if (command === "fire") {
  const chalk = (await import("chalk")).default;
  const { getTable, loadListenerState } = await import("./core/tables.js");
  const { httpRequest } = await import("./core/client.js");
  const { trackFire } = await import("./core/usage.js");

  const tableName = subcommand;
  const args = rest;
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (f: string) => args.includes(f);

  if (!tableName) {
    console.error(
      chalk.red(
        "Usage: fire <table-name> --data '{...}' [--wait] [--timeout 120]",
      ),
    );
    process.exit(1);
  }

  const table = getTable(tableName);
  if (!table) {
    console.error(
      chalk.red(`Table "${tableName}" not found. Run: tables list`),
    );
    process.exit(1);
  }

  const dataRaw = getFlag("--data") ?? getFlag("-d");
  if (!dataRaw) {
    console.error(chalk.red("Required: --data <json>"));
    process.exit(1);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataRaw);
  } catch {
    console.error(chalk.red("Invalid JSON in --data"));
    process.exit(1);
  }

  const wait = hasFlag("--wait") || hasFlag("-w");
  const timeout = parseInt(getFlag("--timeout") ?? getFlag("-t") ?? "120");
  const callbackId = randomUUID();

  if (wait) {
    const listener = loadListenerState();
    if (!listener) {
      console.error(
        chalk.red("No listener running. Start one first: listen start"),
      );
      process.exit(1);
    }
    try {
      process.kill(listener.pid, 0);
    } catch {
      console.error(
        chalk.red("Listener process is dead. Restart: listen start"),
      );
      process.exit(1);
    }
    payload._callback_url = `${listener.tunnelUrl}/callback/${callbackId}`;
    payload._callback_id = callbackId;
  }

  const headers: Record<string, string> = {};
  if (table.authKey) headers["Authorization"] = `Bearer ${table.authKey}`;

  try {
    await httpRequest({
      url: table.webhookUrl,
      method: "POST",
      body: payload,
      headers,
    });
    trackFire(tableName, table.rowLimit);

    if (!wait) {
      console.log(
        chalk.green(`Fired to "${tableName}" (callback: ${callbackId})`),
      );
      process.exit(0);
    }

    const listener = loadListenerState()!;
    const pollUrl = `http://localhost:${listener.port}/callback/${callbackId}`;
    const deadline = Date.now() + timeout * 1000;
    console.log(chalk.dim(`Waiting for callback (timeout: ${timeout}s)...`));

    while (Date.now() < deadline) {
      try {
        const res = await fetch(pollUrl);
        if (res.ok) {
          const body = (await res.json()) as Record<string, unknown>;
          if (body && "payload" in body) {
            console.log(chalk.green("Callback received:"));
            console.log(JSON.stringify(body.payload, null, 2));
            process.exit(0);
          }
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.error(chalk.red(`Timed out after ${timeout}s`));
    process.exit(1);
  } catch (err) {
    console.error(chalk.red(`Fire failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ── listen ──────────────────────────────────────────────────────────────────

if (command === "listen") {
  const chalk = (await import("chalk")).default;
  const { saveListenerState, loadListenerState } =
    await import("./core/tables.js");

  if (subcommand === "status") {
    const state = loadListenerState();
    if (!state) {
      console.log(chalk.yellow("No listener running."));
      process.exit(0);
    }
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    console.log(
      alive ? chalk.green("Listener running") : chalk.red("Listener stopped"),
    );
    console.log(chalk.dim(`  PID:    ${state.pid}`));
    console.log(chalk.dim(`  Port:   ${state.port}`));
    console.log(chalk.dim(`  Tunnel: ${state.tunnelUrl}`));
    console.log(chalk.dim(`  Since:  ${state.startedAt}`));
    process.exit(0);
  }

  // Default: start
  const args =
    subcommand === "start" ? rest : [subcommand, ...rest].filter(Boolean);
  const portFlag = args.indexOf("--port");
  const port =
    portFlag !== -1 && args[portFlag + 1] ? parseInt(args[portFlag + 1]) : 0;

  const { startCallbackServer } = await import("./core/listener.js");
  const { startTunnel } = await import("./core/tunnel.js");

  const { port: resolvedPort, server } = await startCallbackServer(port);

  let tunnelUrl: string;
  try {
    console.log(chalk.dim("Starting cloudflared tunnel..."));
    tunnelUrl = await startTunnel(resolvedPort);
  } catch (err) {
    server.close();
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }

  saveListenerState({
    pid: process.pid,
    port: resolvedPort,
    tunnelUrl,
    startedAt: new Date().toISOString(),
  });

  console.log(chalk.green("\nCallback listener running:"));
  console.log(chalk.dim(`  Local:  http://localhost:${resolvedPort}`));
  console.log(chalk.dim(`  Tunnel: ${tunnelUrl}`));
  console.log(
    chalk.dim("\nClay will POST enrichment results to: <tunnel>/callback/<id>"),
  );
  console.log(chalk.dim("Press Ctrl+C to stop.\n"));

  await new Promise<void>((res) => {
    const shutdown = () => {
      server.close();
      res();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  process.exit(0);
}

// ── usage ───────────────────────────────────────────────────────────────────

if (command === "usage") {
  const chalk = (await import("chalk")).default;
  const { loadTables } = await import("./core/tables.js");
  const { getTableUsage } = await import("./core/usage.js");

  const name = subcommand;
  if (name && name !== "show") {
    const usage = getTableUsage(name);
    const pct =
      usage.limit > 0 ? Math.round((usage.count / usage.limit) * 100) : 0;
    console.log(chalk.cyan(name));
    console.log(`  Rows:      ${usage.count}/${usage.limit} (${pct}%)`);
    console.log(`  Remaining: ${usage.limit - usage.count}`);
    if (usage.lastFired) console.log(`  Last fired: ${usage.lastFired}`);
    process.exit(0);
  }

  const store = loadTables();
  const tables = Object.values(store.tables);
  if (tables.length === 0) {
    console.log(chalk.yellow("No tables registered."));
    process.exit(0);
  }
  for (const t of tables) {
    const usage = getTableUsage(t.name);
    const pct = Math.round((usage.count / t.rowLimit) * 100);
    const color =
      pct >= 90 ? chalk.red : pct >= 70 ? chalk.yellow : chalk.green;
    console.log(
      `${chalk.cyan(t.name)}  ${color(`${usage.count}/${t.rowLimit}`)} (${pct}%)`,
    );
  }
  process.exit(0);
}

// ── dedup ───────────────────────────────────────────────────────────────────

if (command === "dedup") {
  const chalk = (await import("chalk")).default;

  if (platform() !== "darwin") {
    console.error(chalk.red("dedup requires macOS (AppleScript + Chrome)."));
    process.exit(1);
  }

  const args = subcommand ? [subcommand, ...rest] : rest;
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
          `\nDry run: ${result.duplicatesRemoved} duplicate rows found`,
        ),
      );
      console.log(
        chalk.dim(`Table: ${result.tableId}, Total rows: ${result.totalRows}`),
      );
    } else if (result.duplicatesRemoved === 0) {
      console.log(chalk.green("\nNo duplicates found. Clay table is clean."));
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

// ── sync ────────────────────────────────────────────────────────────────────

if (command === "sync") {
  const chalk = (await import("chalk")).default;
  const ora = (await import("ora")).default;

  const args = subcommand ? [subcommand, ...rest] : rest;
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (f: string) => args.includes(f);

  const sourcesRaw = getFlag("--sources") ?? "all";
  const csvFlag = getFlag("--csv");
  const tableFlag = getFlag("--table");
  const webhookFlag = getFlag("--webhook");
  const resyncAll = hasFlag("--all");
  const dryRun = hasFlag("--dry-run");
  const verbose = hasFlag("--verbose");

  const sources =
    sourcesRaw === "all"
      ? ["linkedin", "imessage", "contacts"]
      : sourcesRaw.split(",").map((s) => s.trim().toLowerCase());

  const { mergeRecords } = await import("./core/merge.js");
  const { loadConfig, saveConfig } = await import("./core/config.js");

  // Resolve webhook URL: --table (registered) > --webhook (raw) > env
  let webhookUrl = "";
  let tableName = "";
  let rowLimit = 50000;

  if (tableFlag) {
    const { getTable } = await import("./core/tables.js");
    const table = getTable(tableFlag);
    if (!table) {
      console.error(
        chalk.red(
          `Table "${tableFlag}" not found. Register it first: tables add`,
        ),
      );
      process.exit(1);
    }
    webhookUrl = table.webhookUrl;
    tableName = table.name;
    rowLimit = table.rowLimit;
  } else {
    const config = loadConfig();
    webhookUrl =
      webhookFlag ??
      config.clayWebhookUrl ??
      process.env.CLAY_WEBHOOK_URL ??
      "";
  }

  if (!webhookUrl && !dryRun) {
    console.error(
      chalk.red(
        "No Clay webhook URL. Use --table <name>, --webhook <url>, or set CLAY_WEBHOOK_URL in .env",
      ),
    );
    process.exit(1);
  }

  type PR = import("./core/types.js").PersonRecord;
  const batches: PR[][] = [];

  // ── LinkedIn ──────────────────────────────────────────────────────────────

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
        spinner.info("LinkedIn: no CSV found. Connecting to Chrome scraper");
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

  // ── iMessage ──────────────────────────────────────────────────────────────

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

  // ── iOS Contacts ──────────────────────────────────────────────────────────

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

  // ── Merge + dedup ─────────────────────────────────────────────────────────

  const mergeSpinner = ora("Merging and deduplicating...").start();
  const merged = mergeRecords(batches);
  mergeSpinner.succeed(`Merged: ${merged.length} unique people`);

  const multiSource = merged.filter((r) => r.sources.length > 1);
  if (multiSource.length > 0) {
    console.log(
      chalk.dim(`  ${multiSource.length} appear in multiple sources`),
    );
  }

  // ── Dry run ───────────────────────────────────────────────────────────────

  const config = loadConfig();
  if (dryRun) {
    const alreadySynced = new Set(config.syncedIds);
    const newCount = merged.filter(
      (r) => !alreadySynced.has(r.submission_id),
    ).length;
    console.log(chalk.yellow("\nDry run. Not posting to Clay."));
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

  // ── Post to Clay ──────────────────────────────────────────────────────────

  const { postToClay } = await import("./core/clay.js");

  const alreadySynced = resyncAll
    ? new Set<string>()
    : new Set(config.syncedIds);
  const toPost = merged.filter((r) => !alreadySynced.has(r.submission_id));

  if (toPost.length === 0) {
    console.log(
      chalk.green("\nAll contacts already synced. Nothing new to send."),
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
          ? chalk.green("*")
          : status === "skipped"
            ? chalk.dim("-")
            : chalk.red("x");
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

  // Track usage if using a registered table
  if (tableName && result.sent > 0) {
    const { trackFireBulk } = await import("./core/usage.js");
    trackFireBulk(tableName, rowLimit, result.sent);
  }

  config.syncedIds = Array.from(alreadySynced);
  config.lastSyncedAt = new Date().toISOString();
  if (webhookUrl) config.clayWebhookUrl = webhookUrl;
  saveConfig(config);

  console.log(chalk.dim(`\nState saved to ~/.d1-networking.json`));
  process.exit(0);
}

// ── help ────────────────────────────────────────────────────────────────────

console.error(`Unknown command: ${command ?? "(none)"}`);
console.error("");
console.error("Commands:");
console.error(
  "  sync              Sync sources to Clay (LinkedIn, iMessage, Contacts)",
);
console.error("  tables            Manage registered Clay webhook tables");
console.error("  fire              Fire a JSON payload to a registered table");
console.error(
  "  listen            Start/check callback listener for Clay enrichment",
);
console.error("  usage             Show row usage per table");
console.error("  imessage          Full iMessage agent");
console.error("  dedup             Remove duplicate rows from Clay table");
console.error("");
console.error("Examples:");
console.error(
  "  bun src/cli.ts tables add --name leads --webhook-url https://api.clay.com/v3/sources/webhook/...",
);
console.error(
  "  bun src/cli.ts sync --sources linkedin,contacts --table leads",
);
console.error('  bun src/cli.ts fire leads --data \'{"linkedin_url": "..."}\'');
console.error("  bun src/cli.ts listen start");
console.error("  bun src/cli.ts usage");
process.exit(1);
