import { useLayoutEffect } from 'react';

import type { AddrbarPlacement } from '../../bridge/useAddrbar';
import { afterMotion } from '../../motion/afterMotion';

const POPUP_SELECTOR = '.muxui-command-palette__popup';
const SHADOW_SELECTOR = '.bento-address-bar__shadow';
const ROW_RADIUS_PROPERTY = '--bento-address-bar-grow-from-radius';

/** The corner radii the clip rounds between, in px. */
export interface GrowRadii {
  /** The sidebar row's, on the start frame. */
  from: number;
  /** The popup's own, at rest. */
  to: number;
}

/**
 * The boxes a grow runs between, in px: the popup as rendered (`width`, `height`) and the sidebar
 * row it grows from (`anchorWidth`, `anchorHeight`), which shares its top-left corner. The popup's
 * size is measured, not the placement's: AddressBar.css caps it by the room in the window, so
 * where the placement's size does not fit, the rendered box is the smaller one.
 */
export type GrowBox = Pick<AddrbarPlacement, 'width' | 'height' | 'anchorWidth' | 'anchorHeight'>;

/**
 * The clip-path the anchored popup grows between: the sidebar row's box (the popup's top-left
 * corner is the row's) to the whole popup, with the corners rounding from the row's radius to
 * the popup's (a clip-path `round` interpolates). Literal pixels, never `var()`: a variable
 * inside a compositor property grades as C-tier in MotionScore, and the numbers are known here
 * (the box is measured once per open). The popup's elevation is not the popup's own box-shadow,
 * which the clip would cut: AddressBar.css draws it on a sibling that grows with the clip
 * (`growShadowTransforms`).
 */
export function growClipPaths(box: GrowBox, radii: GrowRadii) {
  const right = Math.max(0, box.width - box.anchorWidth);
  const bottom = Math.max(0, box.height - box.anchorHeight);
  return {
    from: `inset(0px ${right}px ${bottom}px 0px round ${radii.from}px)`,
    to: `inset(0px 0px 0px 0px round ${radii.to}px)`,
  };
}

/**
 * The transform the elevation sibling grows through, top-left pinned: it is drawn at the popup's
 * final box, so scaling it to the row's box (clamped like the clip's insets) and back to full size
 * keeps its box on the clip's visible box every frame. Both interpolate linearly on the same
 * spring pair, so a full-size shadow never stands behind a still-clipped popup, where the page
 * would show through the gap. Literal numbers, never `var()`, for the same reason as the clip.
 */
export function growShadowTransforms(box: GrowBox) {
  const sx = Math.min(box.width, box.anchorWidth) / box.width;
  const sy = Math.min(box.height, box.anchorHeight) / box.height;
  return {
    from: `scale(${sx}, ${sy})`,
    to: 'scale(1, 1)',
  };
}

function prefersReducedMotion(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  return (
    view?.matchMedia('(prefers-reduced-motion: reduce)').matches === true ||
    el.closest('[data-reduced-motion], [data-muxui-motion="reduced"]') !== null
  );
}

/**
 * Replays the anchored popup's grow on every open: the popup stays mounted between opens, so a
 * mount or `data-entering` animation would run only once. The start frame (the row's box) is
 * committed before paint, then the clip moves to the full popup on the `reveal` spring pair
 * (AddressBar.css reads the pair, keyed on `data-bento-grow`). The elevation sibling grows in
 * the same frames: its scale goes from the row's box to full size and its opacity from 0 to 1
 * on the same pair, so it tracks the clip. Both start from the popup's measured box (read before
 * the start frame and again before the transition begins, because a document shown after its
 * window was resized still has the old viewport for its first frames). Reduced motion opens at
 * full size. The popup is the Mux popup element around the dialog, which takes no `style` prop.
 */
export function useAddressBarGrow(
  dialog: HTMLElement | null,
  placement: AddrbarPlacement | null,
  openVersion: number,
): void {
  useLayoutEffect(() => {
    const popup = dialog?.closest<HTMLElement>(POPUP_SELECTOR);
    if (!popup || !placement || prefersReducedMotion(popup)) return;

    // The popup's rendered box, border-box like the clip. AddressBar.css sizes it as the placement
    // capped by the room left in the window, which chrome does not recompute when the window
    // changes under an open palette. A box that is not laid out reads 0 and takes the placement's
    // size.
    const measure = (): GrowBox => {
      const rendered = popup.getBoundingClientRect();
      return {
        width: rendered.width || placement.width,
        height: rendered.height || placement.height,
        anchorWidth: placement.anchorWidth,
        anchorHeight: placement.anchorHeight,
      };
    };
    const computed = getComputedStyle(popup);
    const radii = {
      // The row's radius is a registered <length> (AddressBar.css), so it reads back as px.
      from: parseFloat(computed.getPropertyValue(ROW_RADIUS_PROPERTY)) || 0,
      to: parseFloat(computed.borderTopLeftRadius) || 0,
    };
    // The shadow is the popup's sibling inside the same backdrop.
    const shadow = popup.parentElement?.querySelector<HTMLElement>(SHADOW_SELECTOR) ?? null;

    const rest = () => {
      delete popup.dataset.bentoGrow;
      popup.style.removeProperty('clip-path');
      popup.style.removeProperty('will-change');
      if (shadow) {
        delete shadow.dataset.bentoGrow;
        shadow.style.removeProperty('transform');
        shadow.style.removeProperty('will-change');
      }
    };
    let box = measure();
    const applyStart = () => {
      popup.style.clipPath = growClipPaths(box, radii).from;
      if (shadow) shadow.style.transform = growShadowTransforms(box).from;
    };
    popup.dataset.bentoGrow = 'start';
    popup.style.willChange = 'clip-path';
    if (shadow) {
      shadow.dataset.bentoGrow = 'start';
      shadow.style.willChange = 'transform, opacity';
    }
    applyStart();

    let stopWaiting = () => {};
    // Two frames: the start frame is styled and painted before the transition begins.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // A document shown after its window was resized reads the old viewport for its first
        // frames, and the cap with it (about 100 ms after the host is shown, still faded out):
        // measure again, and start from the box the popup has now.
        const settled = measure();
        if (
          Math.abs(settled.width - box.width) > 0.5 ||
          Math.abs(settled.height - box.height) > 0.5
        ) {
          box = settled;
          applyStart();
          // Commit the corrected start values, so the transition begins from them.
          void popup.getBoundingClientRect();
        }
        popup.dataset.bentoGrow = 'running';
        popup.style.clipPath = growClipPaths(box, radii).to;
        if (shadow) {
          shadow.dataset.bentoGrow = 'running';
          shadow.style.transform = growShadowTransforms(box).to;
        }
        stopWaiting = afterMotion(popup, { properties: ['clip-path'] }, rest);
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      stopWaiting();
      rest();
    };
  }, [dialog, placement, openVersion]);
}
