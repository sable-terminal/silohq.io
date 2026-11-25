-- Undo 002_auth.
DROP FUNCTION IF EXISTS claim_invitation(text);
DROP FUNCTION IF EXISTS invitation_by_token(text);

DROP POLICY IF EXISTS auth_events_tenant ON auth_events;
DROP POLICY IF EXISTS invitations_tenant ON invitations;

DROP TABLE IF EXISTS auth_events;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS mfa_factors;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS sessions;
