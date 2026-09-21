-- Audit log of automated actions Maya has taken (Freshdesk updates, Redash queries, etc.)
-- Phase 4 approval dashboard will read from this table.
CREATE TABLE IF NOT EXISTS task_queue (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual', -- 'meeting' | 'checkin' | 'manual'
  action_type  TEXT NOT NULL, -- 'freshdesk' | 'redash' | 'coralogix' | 'email'
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'pending_approval' | 'rejected'
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_queue_user_created ON task_queue (user_id, created_at DESC);
