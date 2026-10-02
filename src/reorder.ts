// Putting the repertoire in order by hand: a long press on a card (on a laptop, the mouse button
// held) lifts it; it follows the pointer, the others make room around an empty slot, and letting
// go puts it there. Moving the finger before the card lifts is scrolling, as always; a lifted card
// near the top or bottom edge scrolls the list along.

const HOLD_MS = 420; // how long a press lifts a card
const SLOP_PX = 8; // moving further than this before then is a scroll, not a press
const EDGE_PX = 64; // near the scroller's edge a lifted card scrolls the list...
const EDGE_SPEED = 14; // ...by up to this many px a frame
const MAKE_ROOM_MS = 180;

export interface Reorder {
  /** A card is lifted (the list shouldn't be rebuilt under it). */
  dragging(): boolean;
}

export function attachReorder(
  grid: HTMLElement,
  scroller: HTMLElement,
  opts: {
    /** Whether this card can be moved (and others put before or after it). */
    movable: (card: HTMLElement) => boolean;
    /** The movable cards' ids in their new order, after `movedId` was put somewhere else. */
    onDrop: (ids: string[], movedId: string) => void;
    /** A drag ended (moved or not). */
    onEnd: () => void;
  },
): Reorder {
  let pending: { pointerId: number; x: number; y: number; card: HTMLElement; timer: number } | null = null;
  let drag: { pointerId: number; card: HTMLElement; slot: HTMLElement; x0: number; y0: number; x: number; y: number; before: string[]; raf: number } | null = null;
  let swallowClick = false;

  const cards = () => Array.from(grid.querySelectorAll<HTMLElement>(':scope > .song-card[data-id]')).filter((c) => c !== drag?.card && opts.movable(c));
  const order = () => Array.from(grid.querySelectorAll<HTMLElement>(':scope > .song-card[data-id], :scope > .drop-slot'))
    .map((c) => (c === drag?.slot ? drag.card : c))
    .filter((c) => opts.movable(c))
    .map((c) => c.dataset.id!);

  const cancelPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  function lift() {
    if (!pending) return;
    const { card, pointerId, x, y } = pending;
    pending = null;
    const r = card.getBoundingClientRect();
    const slot = document.createElement('li');
    slot.className = 'drop-slot';
    slot.setAttribute('aria-hidden', 'true');
    slot.style.height = `${r.height}px`;
    grid.insertBefore(slot, card);
    card.classList.remove('is-tilted');
    card.classList.add('lifted');
    Object.assign(card.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0' });
    drag = { pointerId, card, slot, x0: x, y0: y, x, y, before: order(), raf: 0 };
    swallowClick = true;
    navigator.vibrate?.(12);
    const tick = () => {
      if (!drag) return;
      const s = scroller.getBoundingClientRect();
      const v = drag.y < s.top + EDGE_PX ? -(1 - (drag.y - s.top) / EDGE_PX) : drag.y > s.bottom - EDGE_PX ? 1 - (s.bottom - drag.y) / EDGE_PX : 0;
      if (v) {
        scroller.scrollTop += Math.max(-1, Math.min(1, v)) * EDGE_SPEED;
        placeSlot();
      }
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  }

  /** Puts the empty slot where the lifted card would land, the others gliding to make room. */
  function placeSlot() {
    if (!drag) return;
    const { x, y, slot } = drag;
    const others = cards();
    if (!others.length) return;
    const rects = others.map((c) => c.getBoundingClientRect());
    const columns = new Set(rects.map((r) => Math.round(r.left))).size > 1;
    // The first card the pointer is before, in reading order.
    let target: HTMLElement | null = null;
    for (let i = 0; i < others.length; i++) {
      const r = rects[i];
      const before = columns ? y < r.top || (y < r.bottom && x < r.left + r.width / 2) : y < r.top + r.height / 2;
      if (before) {
        target = others[i];
        break;
      }
    }
    const ref = target ?? others[others.length - 1].nextSibling;
    if (ref === slot || slot.nextSibling === ref) return;
    const was = new Map(others.map((c, i) => [c, rects[i]]));
    grid.insertBefore(slot, ref);
    for (const c of others) {
      const a = was.get(c)!;
      const b = c.getBoundingClientRect();
      if (Math.abs(a.left - b.left) + Math.abs(a.top - b.top) < 1) continue;
      c.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: MAKE_ROOM_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }

  function drop() {
    if (!drag) return;
    const { card, slot, raf, before } = drag;
    cancelAnimationFrame(raf);
    const from = card.getBoundingClientRect();
    grid.insertBefore(card, slot);
    slot.remove();
    card.classList.remove('lifted');
    for (const p of ['position', 'left', 'top', 'width', 'height', 'margin', 'transform'] as const) card.style.removeProperty(p);
    const to = card.getBoundingClientRect();
    card.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { duration: MAKE_ROOM_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    drag = null;
    const after = order();
    if (after.join() !== before.join()) opts.onDrop(after, card.dataset.id!);
    opts.onEnd();
  }

  grid.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || drag) return;
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('.song-card[data-id]');
    if (!card || target.closest('.song-more') || !opts.movable(card)) return;
    cancelPending();
    pending = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, card, timer: window.setTimeout(lift, HOLD_MS) };
  });
  window.addEventListener('pointermove', (e) => {
    if (pending && e.pointerId === pending.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > SLOP_PX) cancelPending();
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.card.style.transform = `translate(${drag.x - drag.x0}px, ${drag.y - drag.y0}px)`;
    placeSlot();
  });
  const release = (e: PointerEvent) => {
    if (pending && e.pointerId === pending.pointerId) cancelPending();
    if (drag && e.pointerId === drag.pointerId) drop();
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  // While a card is lifted, a finger's movement is the drag, not a scroll -- and the press isn't
  // a long-press menu.
  grid.addEventListener('touchmove', (e) => {
    if (drag) e.preventDefault();
  }, { passive: false });
  grid.addEventListener('contextmenu', (e) => {
    if (pending || drag) e.preventDefault();
  });
  // Letting go of a lifted card isn't a click on it.
  grid.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  grid.addEventListener('pointerdown', () => (swallowClick = false), true);

  return { dragging: () => drag !== null };
}
