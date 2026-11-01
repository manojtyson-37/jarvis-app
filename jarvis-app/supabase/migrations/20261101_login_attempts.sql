-- Failed-login log for the Maya login lockout. Additive only.
-- RLS is ON with NO policies, and anon/authenticated are revoked: the public anon key cannot read,
-- insert or delete rows here (otherwise an attacker could wipe their own attempts and reset the lockout).
-- Only the server-side service-role key (bypasses RLS) touches this table.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts (created_at DESC);
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE login_attempts_id_seq FROM anon, authenticated;
