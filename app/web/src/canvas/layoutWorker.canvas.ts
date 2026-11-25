// Layout off the main thread (spec 29.8): the page posts the members' structure, the worker posts
// back their positions and what it could not place. Nothing is kept here between requests.

import { layout, type LayoutInput } from './layouts.canvas.ts';

self.onmessage = (event: MessageEvent<{ id: number; input: LayoutInput }>) => {
  const { id, input } = event.data;
  self.postMessage({ id, output: layout(input) });
};
