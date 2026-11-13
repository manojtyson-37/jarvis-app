-- Job search: application tracker (filled from Gmail by a small classifier) and the profile facts used to draft
-- recruiter replies.
-- ADDITIVE ONLY: two new tables, no drops, no deletes, no changes to existing tables or rows.
-- Server-only access: RLS is enabled with no policies (the service-role key bypasses it) and anon/authenticated are
-- revoked, matching 20261111_enable_rls_all_public.sql, so the public anon key can read and write nothing here.
--   Undo: DROP TABLE job_applications, job_profile;   (new tables only, safe at any time)

-- One row per (company, role). The latest email about it sets status/evidence; notified_status is the last status
-- Manoj was pushed about, so a status change nudges exactly once. The pending_ask_* fields hold a recruiter request
-- (resume, CTC, notice period...) that is waiting for his reply; ask_nudged_at stops repeat reminders.
CREATE TABLE IF NOT EXISTS job_applications (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           TEXT NOT NULL,
  company           TEXT NOT NULL CHECK (length(company) BETWEEN 1 AND 120),
  company_key       TEXT NOT NULL CHECK (length(company_key) BETWEEN 1 AND 120),   -- lowercased, for matching
  role              TEXT NOT NULL DEFAULT '' CHECK (length(role) <= 160),
  role_key          TEXT NOT NULL DEFAULT '' CHECK (length(role_key) <= 160),
  status            TEXT NOT NULL CHECK (status IN ('applied', 'moved_forward', 'interview', 'rejected', 'offer')),
  last_update_at    TIMESTAMPTZ NOT NULL,
  source_message_id TEXT NOT NULL,
  source_thread_id  TEXT,
  evidence          TEXT NOT NULL DEFAULT '' CHECK (length(evidence) <= 300),
  notified_status   TEXT CHECK (notified_status IN ('applied', 'moved_forward', 'interview', 'rejected', 'offer')),
  pending_ask       TEXT CHECK (length(pending_ask) <= 300),
  ask_from          TEXT CHECK (length(ask_from) <= 200),
  ask_message_id    TEXT,
  ask_thread_id     TEXT,
  ask_at            TIMESTAMPTZ,
  ask_nudged_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_key, role_key)
);
CREATE INDEX IF NOT EXISTS idx_job_applications_user ON job_applications (user_id, last_update_at DESC);

-- Manoj's own facts for drafted replies. Only he sets these (from his own chat message); drafts never invent them.
CREATE TABLE IF NOT EXISTS job_profile (
  user_id        TEXT PRIMARY KEY,
  total_exp      TEXT CHECK (length(total_exp) <= 80),
  relevant_exp   TEXT CHECK (length(relevant_exp) <= 80),
  current_ctc    TEXT CHECK (length(current_ctc) <= 80),
  expected_ctc   TEXT CHECK (length(expected_ctc) <= 80),
  notice_period  TEXT CHECK (length(notice_period) <= 80),
  location       TEXT CHECK (length(location) <= 120),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_profile      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_applications, job_profile FROM anon, authenticated;
