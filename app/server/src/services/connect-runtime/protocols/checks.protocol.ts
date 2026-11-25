// What only a protocol engine can say about a manifest: which auth strategies it runs, and
// the checks of its own grammar (an SQL dialect is known to the SQL engine alone). Pure;
// the registry runs these at save, beside the schema and the expression checks.

import type { AuthStrategy, Manifest } from '../../../contracts/connect/manifest.contract.ts';
import { graphqlChecks } from './graphql/checks.protocol.ts';
import { odataChecks } from './odata/checks.protocol.ts';
import { soapChecks } from './soap/checks.protocol.ts';
import { sqlChecks } from './sql/checks.protocol.ts';

export interface ProtocolIssue {
  path: string;
  code: string;
  message: string;
}

// A strategy is listed once its placement is built (services/credential, or the agent for
// agent custody).
const STRATEGIES: Readonly<Record<Manifest['protocol']['kind'], readonly AuthStrategy[]>> = {
  rest: ['none', 'api_key', 'bearer', 'basic', 'oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh', 'expression'],
  // The agent holds the database login (custody agent, spec 10.7).
  sql: ['none', 'username_password'],
  // Over HTTP, placed by the credential service as for REST.
  graphql: ['none', 'api_key', 'bearer', 'basic', 'oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh', 'expression'],
  // HTTP-level credentials, placed as for REST, and WS-Security's UsernameToken in the envelope's header.
  soap: ['none', 'api_key', 'bearer', 'basic', 'oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh', 'expression', 'ws_security'],
  // Nothing is sent to the source: the cell's relay posts what it forwards.
  email: ['none'],
  // Over HTTP, placed as for REST (SAP Gateway: basic or OAuth).
  odata: ['none', 'api_key', 'bearer', 'basic', 'oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh', 'expression'],
  // An SSH login, opened by the credential service, which runs the SFTP session.
  sftp: ['username_password', 'ssh_key'],
  // No login: the agent's host reads the share with its own permissions, beneath its owner's roots.
  file_share: ['none'],
  // The broker's login, sealed by the credential service to the agent for one piece of work.
  mqtt: ['none', 'username_password'],
  // The server's user login, sealed to the agent for one piece of work; anonymous otherwise.
  opc_ua: ['none', 'username_password'],
};

export function protocolIssues(manifest: Manifest): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  if (!STRATEGIES[manifest.protocol.kind].includes(manifest.auth.strategy)) {
    issues.push({
      path: 'auth.strategy', code: 'manifest.strategy_unsupported',
      message: `the ${manifest.protocol.kind} engine does not run the ${manifest.auth.strategy} strategy in this release`,
    });
  }
  if (manifest.protocol.kind === 'sql') issues.push(...sqlChecks(manifest));
  if (manifest.protocol.kind === 'graphql') issues.push(...graphqlChecks(manifest));
  if (manifest.protocol.kind === 'soap') issues.push(...soapChecks(manifest));
  if (manifest.protocol.kind === 'odata') issues.push(...odataChecks(manifest));
  return issues;
}
