-- Maya multi-step agent loop: one row per goal (agent_runs) and one row per tool step (agent_steps).
-- Additive only: two new tables and their indexes. No existing table, row or policy is changed or dropped.
-- The run's `messages` column is its checkpoint: it is written after every step, so a run that dies mid-way
-- resumes from its last finished step instead of starting over.
-- Approval-tier steps never run here: they are queued in pending_actions (existing gate) and the run waits.
CREATE TABLE IF NOT EXISTS agent_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  goal         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'chat',
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled')),
  plan         JSONB NOT NULL DEFAULT '[]'::jsonb,
  messages     JSONB NOT NULL DEFAULT '[]'::jsonb,
  state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  result       TEXT,
  lease_owner  UUID,
  lease_until  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_status ON agent_runs (user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_steps (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES agent_runs(id),
  user_id            TEXT NOT NULL,
  idx                INT NOT NULL,
  tool               TEXT NOT NULL,
  tool_call_id       TEXT NOT NULL,
  args               JSONB NOT NULL DEFAULT '{}'::jsonb,
  tier               TEXT NOT NULL CHECK (tier IN ('auto', 'approval')),
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'done', 'failed', 'waiting_approval', 'approved', 'rejected', 'expired')),
  result             TEXT,
  pending_action_id  UUID REFERENCES pending_actions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps (run_id, idx);
CREATE INDEX IF NOT EXISTS idx_agent_steps_action ON agent_steps (pending_action_id) WHERE pending_action_id IS NOT NULL;

-- Same posture as every other public table (20261111_enable_rls_all_public.sql): RLS on, no policies.
-- Only the server (service-role key) reads or writes; the public anon key gets nothing.
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_steps ENABLE ROW LEVEL SECURITY;
