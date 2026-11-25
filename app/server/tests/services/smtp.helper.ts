// A fake SMTP relay for tests: accepts every message into an inbox, nothing sent anywhere; and
// the decoded text/plain part of a message. Shared by notify's tests and the web client's
// browser tests (emailed links opened in a real browser).

import net from 'node:net';

export interface Received { from: string; to: string[]; data: string }

export async function fakeSmtp(): Promise<{ port: number; inbox: Received[]; close(): Promise<void> }> {
  const inbox: Received[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let current: Received = { from: '', to: [], data: '' };
    let inData = false;
    socket.write('220 fake.relay ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\r\n'); at >= 0; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            inbox.push(current);
            current = { from: '', to: [], data: '' };
            socket.write('250 2.0.0 queued\r\n');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.relay\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL') { current.from = line; socket.write('250 2.1.0 ok\r\n'); }
        else if (verb === 'RCPT') { current.to.push(/<([^>]+)>/.exec(line)?.[1] ?? ''); socket.write('250 2.1.5 ok\r\n'); }
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    inbox,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The text/plain part of a message, decoded.
export function plainText(data: string): string {
  const parts = data.split(/\r\n--[^\r\n]+\r\n/);
  const part = parts.find((p) => /content-type: text\/plain/i.test(p)) ?? data;
  const [headers, ...body] = part.split('\r\n\r\n');
  const text = body.join('\r\n\r\n');
  if (/content-transfer-encoding: base64/i.test(headers!)) return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding: quoted-printable/i.test(headers!)) {
    return text.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return text;
}
