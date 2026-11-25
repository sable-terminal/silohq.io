// The five state glyphs of spec 28.4, drawn once per theme into an icon atlas for deck.gl, so a
// state is told by its shape as well as its colour and the canvas reads in greyscale: normal a
// filled circle in a neutral fill; warning a triangle, amber; failed a square with a cross, red;
// unknown an outlined circle with a question mark; stale a clock over hatching.

import type { State } from './lod.canvas.ts';

const SIZE = 64;
const ORDER: State[] = ['normal', 'warning', 'failed', 'unknown', 'stale'];

export interface Atlas { atlas: HTMLCanvasElement; mapping: Record<State, { x: number; y: number; width: number; height: number; anchorY: number }> }

export function stateAtlas(colour: Record<State, [number, number, number]>, surface: [number, number, number]): Atlas {
  const atlas = document.createElement('canvas');
  atlas.width = SIZE * ORDER.length;
  atlas.height = SIZE;
  const g = atlas.getContext('2d')!;
  const css = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const mapping = {} as Atlas['mapping'];
  ORDER.forEach((state, i) => {
    const x0 = i * SIZE;
    const cx = x0 + SIZE / 2;
    const cy = SIZE / 2;
    const r = SIZE * 0.36;
    g.save();
    g.lineWidth = 6;
    g.strokeStyle = css(colour[state]);
    g.fillStyle = css(colour[state]);
    switch (state) {
      case 'normal':
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        break;
      case 'warning':
        g.beginPath(); g.moveTo(cx, cy - r * 1.15); g.lineTo(cx + r * 1.1, cy + r * 0.85); g.lineTo(cx - r * 1.1, cy + r * 0.85); g.closePath(); g.fill();
        break;
      case 'failed':
        g.fillRect(cx - r, cy - r, r * 2, r * 2);
        g.strokeStyle = css(surface);
        g.beginPath(); g.moveTo(cx - r * 0.6, cy - r * 0.6); g.lineTo(cx + r * 0.6, cy + r * 0.6); g.moveTo(cx + r * 0.6, cy - r * 0.6); g.lineTo(cx - r * 0.6, cy + r * 0.6); g.stroke();
        break;
      case 'unknown':
        g.fillStyle = css(surface);
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = css(colour[state]);
        g.font = `bold ${Math.round(SIZE * 0.42)}px system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('?', cx, cy + 2);
        break;
      case 'stale': {
        // Hatching inside the clock face, then the face and its hands.
        g.save();
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
        g.fillStyle = css(surface); g.fillRect(x0, 0, SIZE, SIZE);
        g.lineWidth = 3;
        for (let d = -SIZE; d < SIZE; d += 9) { g.beginPath(); g.moveTo(x0 + d, SIZE); g.lineTo(x0 + d + SIZE, 0); g.stroke(); }
        g.restore();
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 6;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - r * 0.62); g.moveTo(cx, cy); g.lineTo(cx + r * 0.5, cy + r * 0.1); g.stroke();
        break;
      }
    }
    g.restore();
    mapping[state] = { x: x0, y: 0, width: SIZE, height: SIZE, anchorY: SIZE / 2 };
  });
  return { atlas, mapping };
}
