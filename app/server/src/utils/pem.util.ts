// PEM certificates: the first certificate's DER, as base64, for a party that takes DER (an OPC UA
// application's certificate sent to the Silo Agent, spec 20.3).

import { AppError } from './errors.util.ts';

const CERTIFICATE = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/;

/** The first certificate in the PEM, DER as base64. */
export function pemToDerBase64(pem: string): string {
  const match = CERTIFICATE.exec(pem);
  if (match === null) throw new AppError('integrity', 'not a PEM certificate', { code: 'pem.not_certificate' });
  return match[1]!.replace(/\s+/g, '');
}
