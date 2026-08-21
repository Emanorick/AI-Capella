import { RULER_HEIGHT_PX } from './pianoRoll';
import type { Player } from './player';

const CLICK_DRAG_THRESHOLD_PX = 5;

/**
 * Wires all pointer/wheel interaction on the roll canvas to the player: panning and pitch
 * scrolling in the note area, loop selection and start-point taps in the ruler strip, and
 * tap-to-preview on notes.
 */
export function installCanvasInput(canvas: HTMLCanvasElement, player: Player) {
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!player.hasScore()) return;
      e.preventDefault();
      if (e.shiftKey) {
        player.panByBeats(e.deltaY / player.pixelsPerBeat());
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Trackpad gestures are rarely perfectly axis-aligned; picking whichever delta actually
        // dominates (rather than "any nonzero deltaX means horizontal") keeps an intended vertical
        // scroll from bleeding a little horizontal pan into the view on every tick.
        player.panByBeats(e.deltaX / player.pixelsPerBeat());
      } else if (e.deltaY !== 0) {
        player.scrollByPixels(e.deltaY);
      }
    },
    { passive: false },
  );

  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragLastY = 0;
  let dragMoved = false;
  let dragAxis: 'x' | 'y' | null = null;
  let loopSelectStartBeat: number | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!player.hasScore()) return;
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    dragMoved = false;
    dragAxis = null;
    canvas.setPointerCapture(e.pointerId);

    // The ruler strip at the top of the roll is the only place that sets the playback start point
    // or a loop region -- everywhere else, clicking/scrolling can't accidentally jump playback.
    if (player.localY(e.clientY) < RULER_HEIGHT_PX) {
      loopSelectStartBeat = player.beatAtClientX(e.clientX);
    } else {
      loopSelectStartBeat = null;
      canvas.classList.add('dragging');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragPointerId !== e.pointerId || !player.hasScore()) return;
    const totalDx = e.clientX - dragStartX;
    const totalDy = e.clientY - dragStartY;
    if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;

    if (loopSelectStartBeat != null) {
      player.previewLoopSelection(loopSelectStartBeat, player.beatAtClientX(e.clientX));
    } else {
      // Lock to whichever axis the drag committed to early on: real pointer movement is rarely
      // perfectly straight, and applying both axes' deltas on every move let a drag meant as
      // vertical-only bleed a little horizontal pan into the view (and vice versa) on every tick.
      if (dragAxis === null && dragMoved) dragAxis = Math.abs(totalDx) > Math.abs(totalDy) ? 'x' : 'y';
      const dx = e.clientX - dragLastX;
      const dy = e.clientY - dragLastY;
      if (dragAxis !== 'y') player.panByBeats(-dx / player.pixelsPerBeat());
      if (dragAxis !== 'x') player.scrollByPixels(-dy);
    }
    dragLastX = e.clientX;
    dragLastY = e.clientY;
  });

  function endDrag(e: PointerEvent) {
    if (dragPointerId !== e.pointerId) return;
    dragPointerId = null;
    canvas.classList.remove('dragging');

    if (loopSelectStartBeat != null) {
      if (dragMoved) {
        player.finalizeLoopSelection(loopSelectStartBeat, player.beatAtClientX(e.clientX));
      } else {
        // A tap (not a drag) in the ruler just sets the start point, same as the old plain click.
        player.setCustomStart(loopSelectStartBeat);
      }
      loopSelectStartBeat = null;
    } else if (!dragMoved && player.hasScore()) {
      player.previewNoteAt(e.clientX, e.clientY);
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => {
    dragPointerId = null;
    loopSelectStartBeat = null;
    canvas.classList.remove('dragging');
  });
}
