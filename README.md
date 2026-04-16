# D1 Networking Automation

Your entire network in one CLI. LinkedIn Voyager API, iMessage agent, iOS Contacts, all synced to Clay with cross-source deduplication, row limit tracking, and async enrichment callbacks.

43 LinkedIn API commands. Full iMessage triage and auto-reply. Apple Contacts reader. Multi-table Clay registry with webhook fire, usage tracking, and cloudflared tunnel listener.

---

## Requirements

- **macOS only.** iMessage, iOS Contacts, and the LinkedIn Chrome scraper all require macOS.
- **Full Disk Access** granted to your terminal app. System Settings > Privacy & Security > Full Disk Access.
- **Bun** installed: `curl -fsSL https://bun.sh/install | bash`
- **Anthropic API key** for the iMessage agent
- **LinkedIn cookies** (li_at + JSESSIONID) for the LinkedIn API
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

| Command    | What it does                                                         |
| ---------- | -------------------------------------------------------------------- |
| `sync`     | Sync LinkedIn/iMessage/Contacts to a Clay table                      |
| `tables`   | Manage registered Clay webhook tables                                |
| `fire`     | Fire a JSON payload to a registered table                            |
| `listen`   | Start callback listener for Clay enrichment results                  |
| `usage`    | Show row usage per table                                             |
| `linkedin` | 43 LinkedIn Voyager API commands (profile, search, messaging, posts) |
| `imessage` | Full iMessage agent (triage, auto-reply, memory, digest)             |
| `dedup`    | Remove duplicate rows from a Clay table via Chrome                   |

---

## LinkedIn API

Full access to LinkedIn's Voyager API using cookie session auth. 43 commands across 10 categories.

### Authentication

Grab your cookies from Chrome DevTools (Application > Cookies > linkedin.com):

```bash
bun src/cli.ts linkedin login --li-at <li_at_cookie> --jsessionid <jsessionid_cookie>

# Check login status
bun src/cli.ts linkedin status
bun src/cli.ts linkedin status --verify

# Remove stored cookies
bun src/cli.ts linkedin logout
```

Cookies can also be set via environment variables: `LINKEDIN_LI_AT` and `LINKEDIN_JSESSIONID`.

### Profile (9 commands)

```bash
bun src/cli.ts linkedin profile me
bun src/cli.ts linkedin profile view johndoe
bun src/cli.ts linkedin profile contact-info johndoe
bun src/cli.ts linkedin profile skills johndoe --limit 50
bun src/cli.ts linkedin profile network johndoe
bun src/cli.ts linkedin profile badges johndoe
bun src/cli.ts linkedin profile privacy johndoe
bun src/cli.ts linkedin profile posts <urn-id> --limit 20
bun src/cli.ts linkedin profile disconnect johndoe
```

### Connections (7 commands)

```bash
# Send a connection request
bun src/cli.ts linkedin connections send ACoAABxxxxxxx --message "Would love to connect"

# View pending invitations
bun src/cli.ts linkedin connections received
bun src/cli.ts linkedin connections sent

# Manage invitations
bun src/cli.ts linkedin connections accept <id> --secret <secret>
bun src/cli.ts linkedin connections reject <id> --secret <secret>
bun src/cli.ts linkedin connections withdraw <id>
bun src/cli.ts linkedin connections remove johndoe
```

### Search (4 commands)

```bash
# Search people with filters
bun src/cli.ts linkedin search people --keywords "software engineer" --network F --company 1035

# Search companies
bun src/cli.ts linkedin search companies --keywords "AI startups"

# Search jobs
bun src/cli.ts linkedin search jobs --keywords "product manager" --location "Los Angeles" --remote

# Search posts
bun src/cli.ts linkedin search posts --keywords "AI trends 2026"
```

Search filters: `--network` (F=1st, S=2nd, O=3rd+), `--company`, `--industry`, `--school`, `--title`, `--first-name`, `--last-name`, `--geo`, `--limit`, `--start`.

### Messaging (6 commands)

```bash
# List conversations
bun src/cli.ts linkedin messaging conversations

# View conversation with a specific person
bun src/cli.ts linkedin messaging conversation-with ACoAABxxxxxxx

# Read messages from a conversation
bun src/cli.ts linkedin messaging messages <conversation-id>

# Send message in existing conversation
bun src/cli.ts linkedin messaging send <conversation-id> --text "Hey, following up"

# Start a new conversation
bun src/cli.ts linkedin messaging send-new --recipients ACoAABxxxxxxx --text "Hi there"

# Mark conversation as read
bun src/cli.ts linkedin messaging mark-read <conversation-id>
```

### Posts (3 commands)

```bash
# Create a post
bun src/cli.ts linkedin posts create --text "Hello LinkedIn!" --visibility anyone

# Create with image
bun src/cli.ts linkedin posts create --text "Check this out" --image ./photo.jpg

# Edit a post
bun src/cli.ts linkedin posts edit <share-urn> --text "Updated text"

# Delete a post
bun src/cli.ts linkedin posts delete <share-urn>
```

### Feed (3 commands)

```bash
bun src/cli.ts linkedin feed view --limit 20
bun src/cli.ts linkedin feed user johndoe --limit 10
bun src/cli.ts linkedin feed company google --limit 10
```

### Engage (4 commands)

```bash
# React to a post
bun src/cli.ts linkedin engage react <post-urn> --type LIKE
# Types: LIKE, PRAISE, APPRECIATION, EMPATHY, INTEREST, ENTERTAINMENT

# View reactions
bun src/cli.ts linkedin engage reactions <post-urn>

# Comment on a post
bun src/cli.ts linkedin engage comment <post-urn> --text "Great insight"

# View comments
bun src/cli.ts linkedin engage comments <post-urn>
```

### Company (3 commands)

```bash
bun src/cli.ts linkedin company view google
bun src/cli.ts linkedin company people <company-id> --limit 25
bun src/cli.ts linkedin company jobs <company-id>
```

### Analytics (2 commands)

```bash
bun src/cli.ts linkedin analytics profile-views
bun src/cli.ts linkedin analytics search-appearances
```

### Jobs (4 commands)

```bash
bun src/cli.ts linkedin jobs search --keywords "software engineer" --location "San Francisco" --remote
bun src/cli.ts linkedin jobs view <job-id>
bun src/cli.ts linkedin jobs save <job-id>
bun src/cli.ts linkedin jobs unsave <job-id>
```

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
4. Name match across different sources (emoji-stripped, only when fields don't conflict)

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

## Architecture

```
src/
  cli.ts                    Entry point: all commands routed here
  core/
    types.ts                PersonRecord schema
    merge.ts                Cross-source dedup (phone, email, LinkedIn slug, name)
    clay.ts                 Webhook poster with retry and rate limiting
    client.ts               HTTP client (retries on 429/5xx, backoff, timeouts)
    tables.ts               Table registry, usage tracking, listener state
    usage.ts                Row limit tracking (90% warn, 100% error)
    errors.ts               Typed error hierarchy
    listener.ts             HTTP callback server for Clay enrichment results
    tunnel.ts               cloudflared tunnel spawner
    config.ts               Sync state persistence (~/.d1-networking.json)
    dedup-clay.ts           Clay table dedup via Chrome session
  linkedin/
    api/
      client.ts             Voyager API client (cookie auth, CSRF, rate limiting)
      commands.ts           All 43 LinkedIn command handlers
      config.ts             LinkedIn session persistence (~/.d1-networking/linkedin.json)
    parse.ts                CSV parser for LinkedIn data export
    adapter.ts              CSV/scraped to PersonRecord
    finder.ts               Auto-detects Connections.csv in ~/Downloads
    scraper.ts              Playwright scraper (cross-platform fallback)
    scraper-applescript.ts  Chrome scraper via AppleScript (macOS)
  imessage/
    agent.ts                Triage, reply, memory, style learning
    clay-export.ts          Reads chat.db for Clay sync
    contacts.ts             AddressBook resolver
    convo.ts                Conversation threading
    db.ts                   chat.db SQLite reader
    memory.ts               Contact profile persistence
    intent.ts               Intent classifier
    integrations.ts         Slack, Firestore, Clay CRM
    perplexity.ts           Web research on unknown contacts
  contacts/
    reader.ts               AddressBook SQLite reader
packages/
  photon-imessage-kit/      Bundled iMessage SDK
```

---

## Environment variables

```bash
# Required for iMessage agent
ANTHROPIC_API_KEY=sk-ant-...

# Required for Clay sync (if not using registered tables)
CLAY_WEBHOOK_URL=https://api.clay.com/v3/sources/webhook/...

# LinkedIn API (alternative to `linkedin login`)
LINKEDIN_LI_AT=AQE...
LINKEDIN_JSESSIONID=ajax:123456789

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
