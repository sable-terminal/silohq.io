DROP POLICY IF EXISTS users_colleague ON users;
DROP POLICY IF EXISTS users_own ON users;
DROP POLICY IF EXISTS sessions_own ON sessions;
DROP POLICY IF EXISTS password_resets_own ON password_resets;
DROP POLICY IF EXISTS mfa_factors_own ON mfa_factors;

ALTER TABLE users           DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        DISABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets DISABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors     DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS user_by_email(text);
DROP FUNCTION IF EXISTS session_by_token(text);
DROP FUNCTION IF EXISTS consume_password_reset(text);
DROP FUNCTION IF EXISTS delete_expired_sessions(timestamptz);
