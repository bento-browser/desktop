import { describe, expect, it } from 'vitest';

import { growClipPaths, growShadowTransforms } from './useAddressBarGrow';

// The popup as rendered: the placement's size while it fits the window.
const box = { width: 512, height: 378, anchorWidth: 266, anchorHeight: 32 };
// A window shrunk under an open palette, or a placement past the room left: the capped popup.
const capped = { ...box, width: 400, height: 90 };

describe('growClipPaths', () => {
  const radii = { from: 6, to: 12 };

  it('starts at the row box, the popup top-left corner, with the row radius', () => {
    expect(growClipPaths(box, radii).from).toBe('inset(0px 246px 346px 0px round 6px)');
  });

  it('ends on the whole popup, with the popup radius', () => {
    expect(growClipPaths(box, radii).to).toBe('inset(0px 0px 0px 0px round 12px)');
  });

  it('insets from the rendered box when the window leaves less room than the placement', () => {
    expect(growClipPaths(capped, radii).from).toBe('inset(0px 134px 58px 0px round 6px)');
  });

  it('never insets a negative amount when the row is wider than the popup', () => {
    expect(growClipPaths({ ...box, anchorWidth: 600 }, radii).from).toBe(
      'inset(0px 0px 346px 0px round 6px)',
    );
  });
});

describe('growShadowTransforms', () => {
  it('starts on the clip start box: the row size over the popup size', () => {
    // The clip insets 246px right and 346px bottom: 266 / 512 and 32 / 378 of the popup remain.
    expect(growShadowTransforms(box).from).toBe(`scale(${266 / 512}, ${32 / 378})`);
  });

  it('scales from the rendered box when the window leaves less room than the placement', () => {
    // Same visible box as the clip: 266 / 400 and 32 / 90 of the capped popup remain.
    expect(growShadowTransforms(capped).from).toBe(`scale(${266 / 400}, ${32 / 90})`);
  });

  it('never scales past full size when the row is wider than the popup', () => {
    expect(growShadowTransforms({ ...box, anchorWidth: 600 }).from).toBe(
      `scale(1, ${32 / 378})`,
    );
  });

  it('ends at full size', () => {
    expect(growShadowTransforms(box).to).toBe('scale(1, 1)');
  });
});
