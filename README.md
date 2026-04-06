# D1 Networking Automation

Your entire network synced to Clay. LinkedIn connections, iMessage threads, and iOS Contacts — merged, deduplicated, and posted to one table so you always know who you know, how you met, and when you last talked.

Use all three sources together, or just the one you need.

---

## Requirements

- **macOS only.** iMessage, iOS Contacts, and the LinkedIn Chrome scraper all require macOS.
- **Full Disk Access** granted to your terminal app. System Settings > Privacy & Security > Full Disk Access.
- **Bun** installed: `curl -fsSL https://bun.sh/install | bash`
- **Anthropic API key** — required for the iMessage agent only
- **Clay webhook URL** — required for syncing to Clay

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

## This repo includes a full iMessage agent

If all you want is the iMessage agent, this is everything. No LinkedIn. No Contacts. Just Bun, Full Disk Access, and an Anthropic API key.

The agent reads your texts directly from `~/Library/Messages/chat.db`, triages every unread conversation with AI, auto-replies in your voice, and builds a living contact memory. No BlueBubbles. No middleware. Pure SQLite.

```bash
# Inbox stats — no API calls
bun src/cli.ts imessage --mode scan

# Full AI triage + auto-reply
bun src/cli.ts imessage --mode run

# See what it would send without sending anything
bun src/cli.ts imessage --mode run --dry-run

# Morning digest: pending questions and prospect gaps
bun src/cli.ts imessage --mode digest

# Full thread view for one contact
bun src/cli.ts imessage --mode chat --handle +13105551234

# Reply to a pending question
bun src/cli.ts imessage --mode answer --id q-xxx --answer "sounds good"

# Send a one-off message
bun src/cli.ts imessage --mode send --handle +13105551234 --message "hey"
```

| Mode     | What it does                                                                        |
| -------- | ----------------------------------------------------------------------------------- |
| `scan`   | Inbox stats and top unreads. No API calls.                                          |
| `inbox`  | Full name-resolved inbox with unread counts.                                        |
| `run`    | Triage every unread. Auto-reply where safe. Queue the rest.                         |
| `style`  | Learn your texting style from 500 historical messages.                              |
| `digest` | Morning summary: pending questions and prospect gaps. Posts to Slack if configured. |
| `chat`   | Full thread view for one contact, with their Clay CRM profile.                      |
| `answer` | Send a reply to a pending question by ID.                                           |
| `send`   | Send a one-off message to any handle.                                               |
| `skip`   | Permanently skip a contact from future triage.                                      |
| `clean`  | Clear pending questions with bad AI drafts.                                         |

Triage uses Claude Haiku to classify each conversation: auto-reply, queue for review, or skip. Replies use Claude Sonnet with optional Perplexity web research on unknown contacts.

Contact memory lives at `~/.imessage-agent/memory.json` — relationship type, texting style, recent topics, trust score, auto-reply safety flag.

---

## Clay sync

Sync any combination of sources into a single Clay table.

```bash
# All three sources
bun src/cli.ts sync --sources all

# LinkedIn only — auto-detects Connections.csv in ~/Downloads
bun src/cli.ts sync --sources linkedin

# LinkedIn with explicit CSV path
bun src/cli.ts sync --sources linkedin --csv ~/Downloads/Connections.csv

# iMessage contacts only
bun src/cli.ts sync --sources imessage

# iOS Contacts only
bun src/cli.ts sync --sources contacts

# Any combination
bun src/cli.ts sync --sources linkedin,imessage

# Dry run — shows what would be posted without posting
bun src/cli.ts sync --sources all --dry-run

# Re-sync everyone (ignore previously synced IDs)
bun src/cli.ts sync --sources all --all
```

### Sources

**LinkedIn** — two modes:

- Auto-detect: drops the CSV from LinkedIn's data export into `~/Downloads` and run. The tool finds it automatically.
- Explicit path: pass `--csv ~/path/to/Connections.csv`
- No CSV: on macOS, scrapes your connections from your open Chrome session via AppleScript

Each connection posts with: name, LinkedIn URL, company, title, connected date, email (if in export), `source: linkedin`.

**iMessage** — reads `~/Library/Messages/chat.db` via SQLite. Requires Full Disk Access.

Every handle you have texted, resolved against AddressBook for real names, with last message date and message count. Unknown numbers are included so you can identify and enrich them in Clay.

Posts with: phone (E.164), display name, last texted date, message count, `source: imessage`.

**iOS Contacts** — reads AddressBook directly from `~/Library/Application Support/AddressBook/`. No iCloud API.

Every contact with a phone number or email: name, organization, all contact methods.

Posts with: name, phone, email, company, `source: contacts`.

---

## Deduplication

All sources are merged before posting. A person who appears in LinkedIn, iMessage, and Contacts becomes one Clay row with `source: linkedin,imessage,contacts`.

Match priority:

1. Phone number (normalized to E.164)
2. Email address
3. LinkedIn URL slug

---

## Clay table schema

| Field                   | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `submission_id`         | Stable unique ID (phone, LinkedIn slug, or email) |
| `name`                  | Display name                                      |
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
  cli.ts              Entry point — imessage, sync, dedup commands
  imessage/           Full iMessage agent
    agent.ts          Triage, reply, memory, style learning
    clay-export.ts    Reads chat.db for Clay sync
    contacts.ts       AddressBook resolver
    memory.ts         Contact profile persistence
    integrations.ts   Slack, Firestore, Clay CRM
  linkedin/
    parse.ts          CSV parser
    adapter.ts        CSV/scraped -> PersonRecord
    finder.ts         Auto-detects Connections.csv in ~/Downloads
    scraper.ts        Playwright scraper (cross-platform fallback)
    scraper-applescript.ts  Chrome scraper via AppleScript (macOS)
  contacts/
    reader.ts         AddressBook SQLite reader
  core/
    types.ts          PersonRecord schema
    merge.ts          Cross-source deduplication
    clay.ts           Webhook poster with retry and rate limiting
    config.ts         Persisted sync state (~/.d1-networking.json)
    dedup-clay.ts     Clay table dedup via Chrome session
packages/
  photon-imessage-kit/  Bundled iMessage SDK (reads chat.db, sends via AppleScript)
```

---

## Environment variables

```bash
# Required for iMessage agent
ANTHROPIC_API_KEY=sk-ant-...

# Required for Clay sync
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

All glory to God! ✝️❤️
