// Moving bytes (spec 41): a file small enough for one request goes in the request, base64; a
// larger one goes straight to storage on a signed, short-lived transfer, then is completed. Cloud
// Storage's signed request opens a resumable session; the bytes go to the session it names.

/** Up to this many bytes travel in one request. */
export const ONE_REQUEST = 8 * 1024 * 1024;

export async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Sends a file's bytes on a signed transfer; throws if storage refuses them. */
export async function sendSigned(transfer: { url: string; method: 'POST' | 'PUT'; headers: Record<string, string> }, file: Blob): Promise<void> {
  if (transfer.headers['x-goog-resumable'] === 'start') {
    const opened = await fetch(transfer.url, { method: transfer.method, headers: transfer.headers });
    const session = opened.headers.get('location');
    if (!opened.ok || session === null) throw new Error('the storage transfer could not be opened');
    if (!(await fetch(session, { method: 'PUT', body: file })).ok) throw new Error('storage did not take the file');
    return;
  }
  if (!(await fetch(transfer.url, { method: transfer.method, headers: transfer.headers, body: file })).ok) throw new Error('storage did not take the file');
}

/** Hands the browser bytes to save under a name. */
export function saveBytes(content: string, contentType: string, name: string): void {
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
