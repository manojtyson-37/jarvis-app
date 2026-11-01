-- Approval gate for outward-facing actions (tiered autonomy).
-- NOTE: the app reads this table with the project's anon key and RLS is off project-wide (known follow-up).
-- Because of that the app never trusts stored summary/args: it re-validates and recomputes the summary on every read and before execution.
-- Write tools never execute directly: they insert a row here, and only the session-gated
-- /api/actions/[id] endpoint can approve it. Additive only — no drops, no deletes.
CREATE TABLE IF NOT EXISTS pending_actions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        JSONB NOT NULL,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','executed','failed','rejected','expired')),
  result      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  decided_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user_status ON pending_actions (user_id, status, created_at DESC);

-- Audit log written by logTaskExecution (also created by 20260921_task_queue.sql; IF NOT EXISTS keeps this idempotent).
CREATE TABLE IF NOT EXISTS task_queue (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',
  action_type  TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'completed',
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
