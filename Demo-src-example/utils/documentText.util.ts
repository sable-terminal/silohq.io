import mammoth from 'mammoth';

/**
 * A Word document's text, and nothing else of it.
 *
 * THE TEXT ONLY: no formatting, no images, no embedded objects. What a model
 * reads and what a flag quotes back is this string, so the offset stored for a
 * value is an offset into exactly this and can be read back from it later.
 */
export async function readDocx(bytes: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return value;
}
