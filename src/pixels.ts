// Canvases sized to the exact device pixels they're shown at.
//
// A canvas's backing store is normally sized as its CSS size times devicePixelRatio, rounded. At a
// whole ratio (2x) that matches the screen exactly; at a fractional one -- a browser zoomed to 90%
// on a Retina display is 1.8x -- the element covers a fractional number of device pixels, at a
// fractional offset, and the browser resamples the whole canvas to fit: every frame softened, text
// most visibly. Chromium-based browsers report the exact device-pixel box the element is painted
// into (ResizeObserver, 'device-pixel-content-box'); a backing store of exactly that size is shown
// 1:1. Elsewhere (Safari, Firefox) the rounded size is kept.

const exact = new WeakMap<Element, { w: number; h: number }>();

/** Takes note of the exact device-pixel sizes a ResizeObserver reported (if it reports them). */
export function notePixelSizes(entries: ResizeObserverEntry[]) {
  for (const e of entries) {
    const box = e.devicePixelContentBoxSize?.[0];
    if (box) exact.set(e.target, { w: box.inlineSize, h: box.blockSize });
  }
}

/** Observes canvases for size changes, in device pixels where the browser can report them. */
export function observePixelSize(observer: ResizeObserver, el: Element) {
  try {
    observer.observe(el, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(el);
  }
}

/**
 * The backing-store size for a canvas shown at cssW x cssH at `dpr`: the exact device-pixel box
 * when known and it belongs to this size and ratio (a capped ratio is a deliberate downscale), else
 * the rounded product.
 */
export function backingSize(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): { w: number; h: number } {
  const rounded = { w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) };
  const box = exact.get(canvas);
  if (!box || Math.abs(dpr - (window.devicePixelRatio || 1)) > 1e-6) return rounded;
  if (Math.abs(box.w - cssW * dpr) > 1.5 || Math.abs(box.h - cssH * dpr) > 1.5) return rounded;
  return { w: Math.max(1, box.w), h: Math.max(1, box.h) };
}
