# D1 Networking Automation

Your entire network synced to Clay. LinkedIn connections, iMessage threads, and iOS Contacts: merged, deduplicated, and posted to one table so you always know who you know, how you met, and when you last talked.

Includes a full table registry, row limit tracking, webhook fire command with async callback support, and a cloudflared tunnel listener for receiving Clay enrichment data.

---

## Requirements

- **macOS only.** iMessage, iOS Contacts, and the LinkedIn Chrome scraper all require macOS.
- **Full Disk Access** granted to your terminal app. System Settings > Privacy & Security > Full Disk Access.
- **Bun** installed: `curl -fsSL https://bun.sh/install | bash`
- **Anthropic API key** for the iMessage agent only
- **Clay webhook URL** for syncing to Clay (or register a table with the CLI)

---

## Setup

```bash
git clone https://github.com/calebnewtonusc/D1-Networking-Automation
cd D1-Networking-Automation
bun install
cp .env.example .env
# Edit .env with your keys
```

---

## Commands

| Command    | What it does                                             |
| ---------- | -------------------------------------------------------- |
| `sync`     | Sync LinkedIn/iMessage/Contacts to a Clay table          |
| `tables`   | Manage registered Clay webhook tables                    |
| `fire`     | Fire a JSON payload to a registered table                |
| `listen`   | Start callback listener for Clay enrichment results      |
| `usage`    | Show row usage per table                                 |
| `imessage` | Full iMessage agent (triage, auto-reply, memory, digest) |
| `dedup`    | Remove duplicate rows from a Clay table via Chrome       |

---

## Table registry

Register Clay tables by name. The CLI tracks webhook URLs, auth keys, row limits, and usage.

```bash
# Register a table
bun src/cli.ts tables add \
  --name leads \
  --webhook-url https://api.clay.com/v3/sources/webhook/... \
  --description "LinkedIn + Contacts sync" \
  --row-limit 50000

# List all registered tables with usage
bun src/cli.ts tables list

# Get table details
bun src/cli.ts tables get leads

# Update webhook URL or auth key
bun src/cli.ts tables update leads --webhook-url https://api.clay.com/v3/sources/webhook/new-url

# Reset row counter (after duplicating a full table in Clay)
bun src/cli.ts tables reset leads --webhook-url https://api.clay.com/v3/sources/webhook/new-url

# Remove a table
bun src/cli.ts tables remove leads
```

Config lives at `~/.d1-networking/tables.json`.

---

## Clay sync

Sync any combination of sources into a registered Clay table.

```bash
# Sync all sources to a registered table
bun src/cli.ts sync --sources all --table leads

# LinkedIn only (auto-detects Connections.csv in ~/Downloads)
bun src/cli.ts sync --sources linkedin --table leads

# LinkedIn with explicit CSV path
bun src/cli.ts sync --sources linkedin --csv ~/Downloads/Connections.csv --table leads

# iMessage contacts only
bun src/cli.ts sync --sources imessage --table leads

# iOS Contacts only
bun src/cli.ts sync --sources contacts --table leads

# Any combination
bun src/cli.ts sync --sources linkedin,contacts --table leads

# Dry run (preview without posting)
bun src/cli.ts sync --sources all --table leads --dry-run --verbose

# Re-sync everyone (ignore previously synced IDs)
bun src/cli.ts sync --sources all --table leads --all

# Raw webhook URL (no registered table needed)
bun src/cli.ts sync --sources all --webhook https://api.clay.com/v3/sources/webhook/...
```

### Sources

**LinkedIn** reads connections from a CSV export or scrapes your open Chrome session via AppleScript. Each connection posts with name, LinkedIn URL, company, title, connected date, email (if in export).

**iMessage** reads `~/Library/Messages/chat.db` via SQLite. Every handle you have texted, resolved against AddressBook for real names, with last message date and message count.

**iOS Contacts** reads AddressBook directly from `~/Library/Application Support/AddressBook/`. Every contact with a phone number: name, phone, email, company.

### Deduplication

All sources are merged before posting. A person who appears in LinkedIn, iMessage, and Contacts becomes one Clay row with `sources: linkedin,imessage,contacts`.

Match priority:

1. Phone number (E.164 normalized)
2. Email address
3. LinkedIn URL slug
4. Name match across different sources (only when fields don't conflict)

---

## Fire webhooks

Send any JSON payload to a registered table. Useful for one-off enrichment, testing, or agent-driven workflows.

```bash
# Fire and forget
bun src/cli.ts fire leads --data '{"linkedin_url": "https://linkedin.com/in/jdoe"}'

# Fire and wait for callback (requires listener running)
bun src/cli.ts fire leads --data '{"linkedin_url": "https://linkedin.com/in/jdoe"}' --wait --timeout 120
```

When using `--wait`, the CLI injects `_callback_url` and `_callback_id` into the payload, then polls the local listener until Clay posts the enriched result back.

---

## Callback listener

Start a local HTTP server with a cloudflared tunnel so Clay can POST enrichment results back to you.

```bash
# Start listener (auto-assigns port, creates cloudflared tunnel)
bun src/cli.ts listen start

# Start on a specific port
bun src/cli.ts listen start --port 9876

# Check if listener is running
bun src/cli.ts listen status
```

Requires `cloudflared` installed: `brew install cloudflared`

The listener stores callback results in memory. The `fire --wait` command polls `http://localhost:<port>/callback/<id>` until the result arrives or the timeout expires.

---

## Usage tracking

Track how many rows each table has consumed toward Clay's 50k row limit.

```bash
# Show all tables
bun src/cli.ts usage

# Show one table
bun src/cli.ts usage leads
```

The CLI warns at 90% usage and errors at 100%. When a table fills up, duplicate it in Clay, get the new webhook URL, and run:

```bash
bun src/cli.ts tables reset leads --webhook-url https://api.clay.com/v3/sources/webhook/new-url
```

---

## iMessage agent

A full iMessage agent that reads your texts directly from `~/Library/Messages/chat.db`, triages every unread conversation with AI, auto-replies in your voice, and builds a living contact memory. No BlueBubbles. No middleware.

```bash
# Inbox stats (no API calls)
bun src/cli.ts imessage --mode scan

# Full AI triage + auto-reply
bun src/cli.ts imessage --mode run

# Dry run (preview without sending)
bun src/cli.ts imessage --mode run --dry-run

# Morning digest
bun src/cli.ts imessage --mode digest

# Full thread view for one contact
bun src/cli.ts imessage --mode chat --handle +13105551234

# Reply to a pending question
bun src/cli.ts imessage --mode answer --id q-xxx --answer "sounds good"

# Send a one-off message
bun src/cli.ts imessage --mode send --handle +13105551234 --message "hey"
```

| Mode     | What it does                                                   |
| -------- | -------------------------------------------------------------- |
| `scan`   | Inbox stats and top unreads. No API calls.                     |
| `inbox`  | Full name-resolved inbox with unread counts.                   |
| `run`    | Triage every unread. Auto-reply where safe. Queue the rest.    |
| `style`  | Learn your texting style from 500 historical messages.         |
| `digest` | Morning summary: pending questions and prospect gaps.          |
| `chat`   | Full thread view for one contact, with their Clay CRM profile. |
| `answer` | Send a reply to a pending question by ID.                      |
| `send`   | Send a one-off message to any handle.                          |
| `skip`   | Permanently skip a contact from future triage.                 |
| `clean`  | Clear pending questions with bad AI drafts.                    |

Triage uses Claude Haiku. Replies use Claude Sonnet with optional Perplexity web research on unknown contacts.

---

## Clay table schema

| Field                   | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `submission_id`         | Stable unique ID (phone, LinkedIn slug, or email) |
| `name`                  | Display name                                      |
| `first_name`            | First name                                        |
| `last_name`             | Last name                                         |
| `phone`                 | E.164 normalized                                  |
| `email`                 | Email if known                                    |
| `linkedin_url`          | LinkedIn profile URL if known                     |
| `company`               | Current company if known                          |
| `title`                 | Current title if known                            |
| `sources`               | Which sources this person appeared in             |
| `last_texted_at`        | ISO date of last iMessage                         |
| `message_count`         | Total messages exchanged                          |
| `linkedin_connected_on` | ISO date of LinkedIn connection                   |
| `imported_at`           | When this row was synced                          |

Clay deduplicates on `submission_id`. Re-running sync only adds new people.

---

## Dedup Clay table

Remove duplicate rows from your Clay table directly (macOS only, requires Clay open in Chrome):

```bash
bun src/cli.ts dedup
bun src/cli.ts dedup --dry-run
```

---

## Architecture

```
src/
  cli.ts                  Entry point: sync, tables, fire, listen, usage, imessage, dedup
  core/
    types.ts              PersonRecord schema
    merge.ts              Cross-source deduplication (phone, email, LinkedIn slug, name)
    clay.ts               Webhook poster with retry and rate limiting
    client.ts             HTTP client (retries on 429/5xx, backoff, timeouts)
    tables.ts             Table registry, usage tracking, listener state (~/.d1-networking/)
    usage.ts              Row limit tracking (90% warn, 100% error)
    errors.ts             Typed error hierarchy (WebhookError, TimeoutError, LimitError)
    listener.ts           HTTP callback server for Clay enrichment results
    tunnel.ts             cloudflared tunnel spawner
    config.ts             Legacy sync state (~/.d1-networking.json)
    dedup-clay.ts         Clay table dedup via Chrome session
  imessage/
    agent.ts              Triage, reply, memory, style learning
    clay-export.ts        Reads chat.db for Clay sync
    contacts.ts           AddressBook resolver
    convo.ts              Conversation threading
    db.ts                 chat.db SQLite reader
    memory.ts             Contact profile persistence
    intent.ts             Intent classifier
    integrations.ts       Slack, Firestore, Clay CRM
    perplexity.ts         Web research on unknown contacts
  linkedin/
    parse.ts              CSV parser
    adapter.ts            CSV/scraped to PersonRecord
    finder.ts             Auto-detects Connections.csv in ~/Downloads
    scraper.ts            Playwright scraper (cross-platform fallback)
    scraper-applescript.ts  Chrome scraper via AppleScript (macOS)
  contacts/
    reader.ts             AddressBook SQLite reader
packages/
  photon-imessage-kit/    Bundled iMessage SDK (reads chat.db, sends via AppleScript)
```

---

## Environment variables

```bash
# Required for iMessage agent
ANTHROPIC_API_KEY=sk-ant-...

# Required for Clay sync (if not using registered tables)
CLAY_WEBHOOK_URL=https://api.clay.com/v3/sources/webhook/...

# Optional: Perplexity web research on unknown contacts
PERPLEXITY_API_KEY=pplx-...

# Optional: Slack digest
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Optional: Firestore logging
FIRESTORE_PROJECT_ID=your-gcp-project-id
FIRESTORE_SA_KEY=/path/to/service-account.json

# Optional: Groq fallback if Anthropic credits run out
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile

# Optional: Loop Message cloud webhook mode
LOOP_API_KEY=
LOOP_SENDER_ID=
LOOP_SENDER_PHONE=+1xxxxxxxxxx
```

---

All glory to God!
