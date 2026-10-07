import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lets an absolutely positioned element be dragged by its background.
 *
 * Pointer events with capture: one handler set covers mouse, pen and touch,
 * and the element keeps receiving moves even when the pointer leaves it.
 * Clicks on controls (buttons, inputs, the chapter list) are not drags.
 */

export interface Point {
  x: number;
  y: number;
}

const NOT_A_HANDLE = 'button, input, select, textarea, a, .tcr-chapters-list, .tcr-help, .tcr-vol-pop';
/** At least this much of the element stays on screen, so it can always be grabbed again. */
const EDGE = 40;

export function useDrag(start: Point, onDrop?: (at: Point) => void) {
  const [position, setPosition] = useState<Point>(start);
  const [active, setActive] = useState(false);
  const grip = useRef<Point | null>(null);
  const latest = useRef<Point>(start);

  useEffect(() => {
    setPosition(start);
    latest.current = start;
  }, [start.x, start.y]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target instanceof Element && e.target.closest(NOT_A_HANDLE)) return;
    const box = e.currentTarget.getBoundingClientRect();
    grip.current = { x: e.clientX - box.left, y: e.clientY - box.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setActive(true);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!grip.current) return;
    const box = e.currentTarget.getBoundingClientRect();
    // The top edge never leaves the screen: that is where the handle is.
    const next = {
      x: Math.min(Math.max(e.clientX - grip.current.x, EDGE - box.width), window.innerWidth - EDGE),
      y: Math.min(Math.max(e.clientY - grip.current.y, 0), window.innerHeight - EDGE),
    };
    latest.current = next;
    setPosition(next);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!grip.current) return;
      grip.current = null;
      setActive(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      onDrop?.(latest.current);
    },
    [onDrop],
  );

  return {
    position,
    active,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
