// Sending mail through the cell's SMTP relay. The Mailer interface is what notify's logic
// depends on; the SMTP adapter is the only one in this build, and a test passes its own.
//
// What may be logged or returned about a failure is a category and the SMTP reply code:
// a relay's reply text can echo the recipient's address, so it is dropped. A connection
// failure or a 4xx reply is retryable; a 5xx reply is not (the relay refused the message).

import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import type { NotifyConfig } from '../../config/notify.config.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

function toAppError(error: unknown): AppError {
  const code = (error as { responseCode?: unknown }).responseCode;
  if (typeof code === 'number' && code >= 500) {
    return new AppError('upstream', 'the mail relay refused the message', {
      code: 'notify.relay_refused', details: { replyCode: code }, retryable: false, cause: error,
    });
  }
  return new AppError('unavailable', 'the mail relay is unavailable', {
    code: 'notify.relay_unavailable', ...(typeof code === 'number' ? { details: { replyCode: code } } : {}), cause: error,
  });
}

export function createSmtpMailer(config: NotifyConfig): Mailer {
  const { smtp } = config;
  if (smtp.host === undefined) throw new AppError('configuration', 'notify needs SMTP_HOST', { code: 'config.notify.smtp' });
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls === 'implicit',
    requireTLS: smtp.tls === 'starttls',
    ignoreTLS: smtp.tls === 'none',
    ...(smtp.username !== undefined ? { auth: { user: smtp.username, pass: smtp.password ?? '' } } : {}),
    ...(smtp.caFile !== undefined ? { tls: { ca: readFileSync(smtp.caFile, 'utf8') } } : {}),
    connectionTimeout: smtp.sendTimeoutMs,
    greetingTimeout: smtp.sendTimeoutMs,
    socketTimeout: smtp.sendTimeoutMs,
    // The message is built from our own text only: no file or URL is ever read into it.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: { name: config.from.name, address: config.from.address },
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        throw toAppError(error);
      }
    },
    close: () => transport.close(),
  };
}
