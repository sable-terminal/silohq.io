// The protocol engines of this release, by protocol. A protocol is code Silo writes; a
// connection to a named system is a manifest one of these executes.

import type { Manifest } from '../../../contracts/connect/manifest.contract.ts';
import type { ProtocolEngine } from '../engine.service.ts';
import { graphqlEngine } from './graphql/graphql.protocol.ts';
import { AppError } from '../../../utils/errors.util.ts';
import { odataEngine } from './odata/odata.protocol.ts';
import { restEngine } from './rest/rest.protocol.ts';
import { sftpEngine } from './sftp/sftp.protocol.ts';
import { mqttEngine } from './mqtt/mqtt.protocol.ts';
import { opcUaEngine } from './opcua/opcua.protocol.ts';
import { soapEngine } from './soap/soap.protocol.ts';
import { sqlEngine } from './sql/sql.protocol.ts';

export const ENGINES: Readonly<Record<Manifest['protocol']['kind'], ProtocolEngine>> = {
  rest: restEngine,
  sql: sqlEngine,
  graphql: graphqlEngine,
  soap: soapEngine,
  odata: odataEngine,
  // SFTP (14.4): files read through the credential service, which runs the session.
  sftp: sftpEngine,
  // A file share (14.4, 10.4): the same files, read by the agent on its host.
  file_share: sftpEngine,
  // MQTT (20.2): the agent's plugin; the cell decodes.
  mqtt: mqttEngine,
  // OPC UA (20.3): the agent's plugin browses and reads.
  opc_ua: opcUaEngine,
  // Email fallback: records arrive only in notifications (spec 14.4); they are read live or through Capture.
  email: {
    read: async () => {
      throw new AppError('validation', 'an email connection\'s records arrive only in its notifications: read them live, or through a Capture Silo',
        { code: 'email.not_readable' });
    },
  },
};
