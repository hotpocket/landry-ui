/**
 * gestures.ts — touch gestures that have to share space with scrolling.
 *
 * Both draggable controls sit inside scrollable panes, so an immediate touch
 * drag competes with the scroll and one of them loses — usually the scroll,
 * which makes the list feel stuck. A long press disambiguates: hold until it
 * engages, then drag. Moving before it engages is a scroll, and cancels.
 *
 * Mouse is untouched: a cursor has no such ambiguity, and requiring a hold
 * there would be a regression for no reason.
 */

export const LONG_PRESS_MS = 350;
export const LONG_PRESS_SLOP_PX = 10;
/** A tap always wobbles a few pixels; treating every wobble as a scroll turned
 *  transcript-follow off constantly. */
export const FOLLOW_SLOP_PX = 10;

export interface DragHandlers {
  start: (t: Touch) => void;
  move: (t: Touch) => void;
  end: () => void;
}

export function longPressDrag(el: HTMLElement, handlers: DragHandlers): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  el.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1) return;   // a pinch is not a drag
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      active = true;
      // A short buzz is the only feedback that the press took, since the finger
      // is covering the control.
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
      handlers.start(t);
    }, LONG_PRESS_MS);
  }, { passive: true });

  // passive:false so the drag can suppress the scroll once engaged.
  el.addEventListener('touchmove', (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    if (timer) {
      if (Math.abs(t.clientX - startX) > LONG_PRESS_SLOP_PX ||
          Math.abs(t.clientY - startY) > LONG_PRESS_SLOP_PX) {
        cancelPress();   // they were scrolling, not grabbing
      }
      return;
    }
    if (!active) return;
    e.preventDefault();
    handlers.move(t);
  }, { passive: false });

  const release = () => {
    cancelPress();
    if (!active) return;
    active = false;
    handlers.end();
  };
  el.addEventListener('touchend', release);
  el.addEventListener('touchcancel', release);
}

/**
 * Whether a touch has moved far enough from its start to count as a scroll
 * rather than a tap.
 */
export function exceededSlop(t: Touch, startX: number, startY: number, slop = FOLLOW_SLOP_PX): boolean {
  return Math.abs(t.clientX - startX) > slop || Math.abs(t.clientY - startY) > slop;
}

/**
 * The panel divider.
 *
 * The panes sit side by side on a wide screen and stacked on a narrow one, so
 * the divider resizes along whichever axis the layout is actually using.
 * Reading it from the computed style means one media query controls both the
 * layout and the gesture.
 *
 * Only the chapter pane is sized; the transcript grows into whatever is left.
 * Giving both a percentage looked symmetrical and was wrong — the pair summed
 * to the container while the divider added its own size on top, so the panes
 * overflowed by exactly the divider and the transcript lost its last lines off
 * the bottom.
 */
export function resizePanels(
  contentArea: HTMLElement,
  chapterPanel: HTMLElement,
  transcriptPanel: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const rect = contentArea.getBoundingClientRect();
  const vertical = getComputedStyle(contentArea).flexDirection === 'column';
  let pct = vertical
    ? ((clientY - rect.top) / rect.height) * 100
    : ((clientX - rect.left) / rect.width) * 100;
  pct = Math.max(5, Math.min(95, pct));
  chapterPanel.style.setProperty('flex', `0 0 ${pct}%`, 'important');
  transcriptPanel.style.setProperty('flex', '1 1 0%', 'important');
}

/**
 * Programmatic scrolls (follow, chapter auto-scroll) fire the same scroll events
 * as user scrolling; mark them so the auto-hiding scrollbar only wakes for real
 * user scrolls. The window covers the smooth-scroll animation.
 */
export function markProgrammaticScroll(el: HTMLElement & { _sbQuietUntil?: number }): void {
  el._sbQuietUntil = Date.now() + 700;
}

/**
 * A hold that fires once, for something that is not a drag.
 *
 * Separate from longPressDrag rather than a mode of it: that one owns the
 * touchmove with passive:false so an engaged drag can suppress the scroll, and
 * a menu has nothing to suppress. Here a move past slop is a scroll and cancels
 * the press, exactly as it does there, and nothing is preventDefault()ed at all.
 *
 * `ignore` exists because the two live on the same row: a hold that begins on
 * the chapter scrubber is a seek, and must not also be a menu.
 */
export function longPress(
  el: HTMLElement,
  fire: () => void,
  ignore?: (target: EventTarget | null) => boolean,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  el.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1) return;   // a pinch is not a press
    if (ignore?.(e.target)) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      // The finger is covering the row it just grabbed; a short buzz is the
      // only feedback available.
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
      fire();
    }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t || !timer) return;
    if (exceededSlop(t, startX, startY, LONG_PRESS_SLOP_PX)) cancel();
  }, { passive: true });

  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
}
