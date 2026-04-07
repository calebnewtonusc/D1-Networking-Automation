-- ─────────────────────────────────────────────────────────────────────────────
-- iMessage Agent — Supabase Schema
-- Multi-user: every agent user owns their own contacts, conversations, learnings.
-- RLS enforces isolation: auth.uid() = user_id on every table.
-- BigQuery-ready: all tables use snake_case, UUIDs, timestamptz.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─── users ────────────────────────────────────────────────────────────────────
-- One row per person running the agent.
-- Links to Supabase auth.users via id.

create table if not exists agent_users (
  id              uuid primary key references auth.users(id) on delete cascade,
  phone           text unique,                  -- primary handle +1xxxxxxxxxx
  email           text,
  display_name    text not null,
  persona         text,                         -- free-text who this person is (AI prompt context)
  own_handles     text[] default '{}',          -- all handles that belong to this user
  style_json      jsonb default '{}',           -- StyleSnapshot: patterns, tone, emoji usage
  config_json     jsonb default '{}',           -- agent preferences: dry_run, max_sends, etc.
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table agent_users enable row level security;
create policy "users own their profile"
  on agent_users for all
  using (auth.uid() = id);

-- ─── contacts ─────────────────────────────────────────────────────────────────
-- Every person/group in the user's iMessage.

create table if not exists contacts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references agent_users(id) on delete cascade,
  handle                text not null,           -- normalized: +1xxxxxxxxxx or email
  display_name          text,
  relationship          text check (relationship in (
                          'friend','bma','family','school','investor',
                          'creator','colleague','professor','random','unknown'
                        )),
  vibe                  text,                    -- one-line personality description
  auto_reply_ok         boolean default false,
  always_skip           boolean default false,
  skip_reason           text,
  last_contacted_at     timestamptz,
  last_replied_at       timestamptz,
  first_contact_at      timestamptz,
  sent_count            int default 0,
  received_count        int default 0,
  trust_score           float default 0 check (trust_score between 0 and 1),
  relationship_score    float default 0,         -- computed: activity + trust
  notes                 text[] default '{}',
  is_group              boolean default false,
  group_name            text,
  conversation_mode     text default 'auto' check (conversation_mode in ('auto','gpt_chat','task','off')),
  preferred_format      text default 'brief' check (preferred_format in ('brief','detailed','list','narrative')),
  research_cache        jsonb default '[]',      -- [{query, result, fetched_at}]
  clay_id               text,                    -- Clay CRM record ID
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique(user_id, handle)
);

create index contacts_user_id_idx on contacts(user_id);
create index contacts_handle_idx on contacts(handle);

alter table contacts enable row level security;
create policy "users own their contacts"
  on contacts for all
  using (auth.uid() = user_id);

-- ─── messages ─────────────────────────────────────────────────────────────────
-- Every parsed iMessage, incoming and outgoing.
-- Synced from local chat.db. imessage_guid is the dedup key.

create table if not exists messages (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references agent_users(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  imessage_guid     text,                        -- ROWID from chat.db for dedup
  chat_id           text,                        -- chat.db chat_identifier
  sender_handle     text not null,
  is_from_me        boolean not null default false,
  text              text,
  body_type         text default 'text' check (body_type in (
                      'text','image','audio','video','sticker','reaction',
                      'attachment','link','location','unknown'
                    )),
  sent_at           timestamptz not null,
  -- Intent fields (populated by intent engine)
  intent_type       text check (intent_type in (
                      'affirmative','negative','stop','question','command',
                      'preference','topic_shift','greeting','farewell',
                      'reaction','casual','unknown'
                    )),
  intent_confidence float check (intent_confidence between 0 and 1),
  intent_payload    jsonb default '{}',          -- {action, entities, raw_match}
  -- Threading
  reply_to_guid     text,                        -- links to the message being replied to
  thread_id         uuid,                        -- groups rapid back-and-forth
  -- Metadata
  is_reaction       boolean default false,
  reaction_type     text,                        -- 'liked','loved','laughed','emphasized','questioned','disliked'
  is_group_chat     boolean default false,
  -- Processing state
  processed_at      timestamptz,                -- null = not yet triaged
  created_at        timestamptz default now()
);

create index messages_user_id_idx on messages(user_id);
create index messages_contact_id_idx on messages(contact_id);
create index messages_sent_at_idx on messages(sent_at desc);
create index messages_imessage_guid_idx on messages(imessage_guid) where imessage_guid is not null;
create index messages_unprocessed_idx on messages(user_id, processed_at) where processed_at is null;

alter table messages enable row level security;
create policy "users own their messages"
  on messages for all
  using (auth.uid() = user_id);

-- ─── intent_events ────────────────────────────────────────────────────────────
-- Structured actions triggered by parsed incoming messages.
-- "yes" -> confirm_meeting. "stop" -> mark always_skip. etc.

create table if not exists intent_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references agent_users(id) on delete cascade,
  message_id      uuid references messages(id) on delete set null,
  contact_id      uuid references contacts(id) on delete set null,
  intent_type     text not null,
  confidence      float not null check (confidence between 0 and 1),
  context         text,                         -- what this intent is responding to
  raw_text        text,                         -- the original message text
  action_taken    text,                         -- 'send_reply','mark_skip','create_task', etc.
  action_result   jsonb default '{}',
  processed_at    timestamptz default now(),
  created_at      timestamptz default now()
);

create index intent_events_user_id_idx on intent_events(user_id);
create index intent_events_contact_id_idx on intent_events(contact_id);

alter table intent_events enable row level security;
create policy "users own their intent events"
  on intent_events for all
  using (auth.uid() = user_id);

-- ─── conversation_sessions ────────────────────────────────────────────────────
-- Active GPT-style chat threads. Each contact can have one active session.
-- message_history is a JSONB array: [{role, content, sent_at, intent_type?}]

create table if not exists conversation_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references agent_users(id) on delete cascade,
  contact_id        uuid not null references contacts(id) on delete cascade,
  mode              text default 'gpt_chat' check (mode in ('gpt_chat','task','support','auto')),
  system_prompt     text,                       -- per-contact customized system prompt
  message_history   jsonb default '[]',         -- [{role:'user'|'assistant', content, sent_at}]
  context_summary   text,                       -- rolling AI-generated summary of older turns
  turn_count        int default 0,
  preferences       jsonb default '{}',         -- {format:'list'|'narrative', tone:'casual'|'formal', emoji:bool, length:'short'|'medium'|'long'}
  last_active_at    timestamptz default now(),
  is_active         boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique(user_id, contact_id)                   -- one active session per contact
);

create index conversation_sessions_user_id_idx on conversation_sessions(user_id);
create index conversation_sessions_active_idx on conversation_sessions(user_id, is_active) where is_active = true;

alter table conversation_sessions enable row level security;
create policy "users own their sessions"
  on conversation_sessions for all
  using (auth.uid() = user_id);

-- ─── pending_questions ────────────────────────────────────────────────────────
-- Agent-to-operator handoff: questions that need human input before auto-sending.

create table if not exists pending_questions (
  id              text primary key,             -- q-{timestamp}-{random}
  user_id         uuid not null references agent_users(id) on delete cascade,
  contact_id      uuid references contacts(id) on delete set null,
  handle          text not null,
  message_preview text,
  questions       text[] default '{}',
  draft_reply     text,
  asked_at        timestamptz default now(),
  answered        boolean default false,
  answer          text,
  answered_at     timestamptz
);

create index pending_questions_user_id_idx on pending_questions(user_id);
create index pending_questions_unanswered_idx on pending_questions(user_id, answered) where answered = false;

alter table pending_questions enable row level security;
create policy "users own their pending questions"
  on pending_questions for all
  using (auth.uid() = user_id);

-- ─── sent_log ─────────────────────────────────────────────────────────────────
-- Every outgoing message, with full context.

create table if not exists sent_log (
  id                  text primary key,
  user_id             uuid not null references agent_users(id) on delete cascade,
  contact_id          uuid references contacts(id) on delete set null,
  to_handle           text not null,
  message             text not null,
  sent_at             timestamptz default now(),
  context             text,
  dry_run             boolean default false,
  conversation_mode   boolean default false,    -- was this a GPT-chat reply?
  session_id          uuid references conversation_sessions(id) on delete set null,
  intent_triggered    text                      -- which intent_type triggered this send
);

create index sent_log_user_id_idx on sent_log(user_id);
create index sent_log_sent_at_idx on sent_log(sent_at desc);

alter table sent_log enable row level security;
create policy "users own their sent log"
  on sent_log for all
  using (auth.uid() = user_id);

-- ─── agent_learnings ──────────────────────────────────────────────────────────
-- Accumulated learnings per user — about the user, their contacts, the world.

create table if not exists agent_learnings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references agent_users(id) on delete cascade,
  content     text not null,
  source      text default 'inference' check (source in ('manual','inference','style_analysis','web_research')),
  confidence  float default 1.0 check (confidence between 0 and 1),
  created_at  timestamptz default now()
);

create index agent_learnings_user_id_idx on agent_learnings(user_id);

alter table agent_learnings enable row level security;
create policy "users own their learnings"
  on agent_learnings for all
  using (auth.uid() = user_id);

-- ─── Triggers: updated_at auto-update ─────────────────────────────────────────

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_agent_users
  before update on agent_users
  for each row execute function touch_updated_at();

create trigger touch_contacts
  before update on contacts
  for each row execute function touch_updated_at();

create trigger touch_conversation_sessions
  before update on conversation_sessions
  for each row execute function touch_updated_at();

-- ─── View: inbox summary ──────────────────────────────────────────────────────
-- Quick read: latest message per contact with intent + trust.

create or replace view inbox_summary as
select
  m.user_id,
  m.contact_id,
  c.handle,
  c.display_name,
  c.relationship,
  c.trust_score,
  c.conversation_mode,
  c.auto_reply_ok,
  m.text as last_message,
  m.is_from_me as last_was_mine,
  m.intent_type as last_intent,
  m.sent_at as last_message_at,
  m.processed_at
from messages m
join contacts c on c.id = m.contact_id
where m.id = (
  select id from messages m2
  where m2.contact_id = m.contact_id
    and m2.user_id = m.user_id
  order by m2.sent_at desc
  limit 1
);
