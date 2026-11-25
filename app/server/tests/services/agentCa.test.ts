// The cell's agent certificate authority (spec 10.2): a request with a P-256 key and a valid
// self-signature gets a 30-day client certificate naming the agent and its organisation,
// signed by the cell's CA; any other request is refused.

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { describe, test } from 'node:test';
import { createAgentCa, fingerprintOf } from '../../src/services/connect-runtime/agentCa.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testAgentRequest } from './agent.helper.ts';

describe('the agent certificate authority (spec 10.2)', () => {
  test('issues a 30-day client certificate for a valid P-256 request, signed by the cell\'s CA', async () => {
    const material = await testAgentCa();
    const ca = await createAgentCa(material);
    const agentId = uuidv7();
    const organisationId = uuidv7();
    const at = new Date('2026-11-16T10:00:00Z');
    const issued = await ca.issue(await testAgentRequest(), { agentId, organisationId }, at);

    const certificate = new X509Certificate(issued.certificatePem);
    const authority = new X509Certificate(material.certificatePem);
    assert.ok(certificate.checkIssued(authority) && certificate.verify(authority.publicKey), 'signed by the CA');
    assert.equal(certificate.ca, false);
    assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.2'], 'client authentication only');
    assert.match(certificate.subject, new RegExp(`CN=${agentId}`));
    assert.match(certificate.subject, new RegExp(`O=${organisationId}`));
    assert.equal(certificate.subjectAltName, `URI:urn:silo:agent:${agentId}`);
    assert.equal(Date.parse(certificate.validTo) - at.getTime(), 30 * 86_400_000);
    assert.deepEqual(issued.fingerprint, fingerprintOf(certificate.raw));
    assert.equal(certificate.serialNumber.toLowerCase().replace(/^0+/, ''), issued.serial.replace(/^0+/, ''));
  });

  test('refuses a request that is not P-256, or whose signature does not verify', async () => {
    const ca = await createAgentCa(await testAgentCa());
    const subject = { agentId: uuidv7(), organisationId: uuidv7() };
    await assert.rejects(ca.issue(await testAgentRequest('RSA'), subject, new Date()), { code: 'agent.csr_invalid' });
    const good = await testAgentRequest();
    const body = good.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const der = Buffer.from(body, 'base64');
    der[der.length - 5] = der[der.length - 5]! ^ 0x01;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
    await assert.rejects(ca.issue(tampered, subject, new Date()), { code: 'agent.csr_invalid' });
    await assert.rejects(ca.issue('not a request', subject, new Date()), { code: 'agent.csr_invalid' });
    await assert.rejects(createAgentCa({ certificatePem: (await testAgentCa()).certificatePem, keyPem: 'nonsense' }), { code: 'config.agent_ca' });
  });
});
