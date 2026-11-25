// A canvas as an image (spec 29.10; D225), drawn by the person's own browser: the canvas it
// shows, with the stamp an export prints above it (the markings first, then the view and when
// it was drawn, each source's state age, the flags and how many objects are not placed) and the
// legend of the state glyphs below it (28.4: each state's shape and word). The markings are the
// server's: an export prints every marking its inputs carry.

import { stateAtlas } from './glyphs.canvas.ts';
import { SEVERITY, type State } from './lod.canvas.ts';

export interface ImageStamp {
  name: string;
  markings: string[];
  drawnAt: string;
  sources: { name: string; age: string }[];
  flags: string[];
  notPlaced: number;
  /** The base map's attribution, printed where its tiles are (D227). */
  attribution?: string | undefined;
}

const LINE = 18;
const PAD = 12;

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

function rgbOf(colour: string): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = colour;
  document.body.appendChild(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m === null ? [128, 128, 128] : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The stamped image, as PNG bytes in base64: the base map (where one is drawn) under the canvas. */
export async function stampedImage(drawn: HTMLCanvasElement, under: HTMLCanvasElement | undefined, stamp: ImageStamp): Promise<string> {
  const scale = drawn.width / Math.max(drawn.clientWidth, 1);
  const lines = [
    stamp.markings.length === 0 ? 'Markings: none' : `Markings: ${stamp.markings.join('; ')}`,
    `${stamp.name} — drawn ${new Date(stamp.drawnAt).toLocaleString('en-GB')}`,
    stamp.sources.length === 0 ? 'Sources: none' : `State age by source: ${stamp.sources.map((s) => `${s.name} ${s.age}`).join('; ')}`,
    `Flags: ${[`${stamp.notPlaced} not placed`, ...stamp.flags].join('; ')}`,
  ];
  const head = (PAD * 2 + LINE * lines.length) * scale;
  const foot = (PAD * 2 + LINE * (stamp.attribution === undefined ? 1 : 2)) * scale;
  const out = document.createElement('canvas');
  out.width = drawn.width;
  out.height = Math.round(head + drawn.height + foot);
  const g = out.getContext('2d')!;
  g.fillStyle = token('--bg', '#ffffff');
  g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = token('--text', '#1b1f24');
  g.textBaseline = 'top';
  lines.forEach((line, i) => {
    g.font = `${i === 0 ? '700' : '400'} ${13 * scale}px system-ui, sans-serif`;
    g.fillText(line, PAD * scale, (PAD + i * LINE) * scale, out.width - 2 * PAD * scale);
  });
  if (under !== undefined) g.drawImage(under, 0, head, drawn.width, drawn.height);
  g.drawImage(drawn, 0, head);
  // The legend: each state's glyph, as the canvas draws it, and its word.
  const colour: Record<State, [number, number, number]> = {
    normal: rgbOf('var(--text-muted)'), warning: rgbOf('var(--warn)'), failed: rgbOf('var(--danger)'), unknown: rgbOf('var(--text)'), stale: rgbOf('var(--text-muted)'),
  };
  const atlas = stateAtlas(colour, rgbOf('var(--surface-raised)'));
  let x = PAD * scale;
  const y = head + drawn.height + PAD * scale;
  g.font = `400 ${12 * scale}px system-ui, sans-serif`;
  for (const state of SEVERITY) {
    const m = atlas.mapping[state];
    g.drawImage(atlas.atlas, m.x, m.y, m.width, m.height, x, y, 16 * scale, 16 * scale);
    const word = state[0]!.toUpperCase() + state.slice(1);
    g.fillText(word, x + 20 * scale, y + 2 * scale);
    x += (28 + g.measureText(word).width / scale) * scale;
  }
  if (stamp.attribution !== undefined) g.fillText(`Base map ${stamp.attribution}`, PAD * scale, y + (LINE + 2) * scale, out.width - 2 * PAD * scale);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('the image could not be made');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
