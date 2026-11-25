DELETE FROM role_permissions WHERE permission_id = 'agent.manage';
DELETE FROM permissions WHERE id = 'agent.manage';
DROP FUNCTION IF EXISTS enrol_agent(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS agent_by_token(text);
DROP TABLE IF EXISTS connection_agent_hosts;
DROP FUNCTION IF EXISTS connection_agent_hosts_one_organisation();
ALTER TABLE connections DROP COLUMN IF EXISTS agent_id;
DROP TABLE IF EXISTS agents;
