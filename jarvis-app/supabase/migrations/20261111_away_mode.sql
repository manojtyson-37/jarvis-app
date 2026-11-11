-- Away Mode: Maya answers inbound email while Manoj is away, escalates only what matters, and logs every decision.
-- ADDITIVE ONLY: three new tables, no drops, no deletes, no changes to existing tables or rows.
-- Server-only access: RLS is enabled with no policies (the service-role key bypasses it) and anon/authenticated are
-- revoked, matching 20261111_enable_rls_all_public.sql, so the public anon key can read and write nothing here.
--   Undo: DROP TABLE agent_actions, escalation_rules, away_sessions;   (new tables only, safe at any time)

-- One row per trip. At most one ACTIVE session per user (partial unique index below).
CREATE TABLE IF NOT EXISTS away_sessions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'killed')),
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ NOT NULL,
  shadow_until  TIMESTAMPTZ NOT NULL,                 -- drafts only (nothing is sent) until this moment
  threshold_inr NUMERIC NOT NULL DEFAULT 50000 CHECK (threshold_inr > 0),
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_away_session_per_user ON away_sessions (user_id) WHERE status = 'active';

-- Manoj's own escalation rules, on top of the built-in ones (money threshold, legal, complaints).
CREATE TABLE IF NOT EXISTS escalation_rules (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('keyword', 'sender', 'category')),
  value      TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  action     TEXT NOT NULL DEFAULT 'escalate_now' CHECK (action IN ('escalate_now', 'needs_you')),
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalation_rules_user ON escalation_rules (user_id) WHERE enabled;

-- Audit log: one row per inbound message the agent looked at. The UNIQUE key is the idempotency guard, so a message
-- can only ever be handled once even if two cron runs overlap.
CREATE TABLE IF NOT EXISTS agent_actions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES away_sessions (id),
  user_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  thread_id   TEXT,
  from_addr   TEXT,
  subject     TEXT,
  decision    TEXT NOT NULL DEFAULT 'processing' CHECK (decision IN ('processing', 'ignore', 'escalate_now', 'needs_you', 'draft', 'auto_reply', 'failed')),
  category    TEXT,
  confidence  NUMERIC,
  amount_inr  NUMERIC,
  summary     TEXT,
  reason      TEXT,
  reply_text  TEXT,
  delivered   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  UNIQUE (session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_session ON agent_actions (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_sender ON agent_actions (session_id, from_addr, decision, created_at);

ALTER TABLE away_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON away_sessions, escalation_rules, agent_actions FROM anon, authenticated;
