"use client";

import { useEffect, useRef, useState } from "react";

// Slower than before, for a deliberate slot-machine spin.
const ROLL_MS = 1800;
// Non-breaking space so literal spaces keep a rendered, non-collapsing column.
const NBSP = " ";

/**
 * Displays a value as a row of per-character reels. Numeric characters spin
 * like a slot machine — the reel rolls forward through the digits (at least one
 * full revolution) and decelerates to land on the new value — while non-numeric
 * characters (currency, separators, units, letters) do a simple slide swap.
 * Only characters that actually change move. Works for prices, weights,
 * durations and dates. Reels collapse to an instant swap under
 * prefers-reduced-motion (globals.css base guard). The full value is exposed
 * once to assistive tech; the visual reels are aria-hidden.
 */
export function RollingValue({ children }: { children: React.ReactNode }) {
  const value = String(children);
  const chars = Array.from(value);
  return (
    <span className="rolling-value">
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="rolling-reels">
        {chars.map((ch, i) =>
          ch >= "0" && ch <= "9" ? (
            <RollingDigit key={i} digit={Number(ch)} />
          ) : (
            <RollingChar key={i} char={ch} />
          ),
        )}
      </span>
    </span>
  );
}

/** A single digit column that spins forward to its new value. */
function RollingDigit({ digit }: { digit: number }) {
  const [reel, setReel] = useState<number[]>([digit]);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const prev = useRef(digit);

  useEffect(() => {
    if (digit === prev.current) return;
    const from = prev.current;
    prev.current = digit;

    // Roll forward from the old digit to the new one, plus one full revolution
    // so even a ±1 change reads as a satisfying spin.
    const steps = ((digit - from + 10) % 10) + 10;
    setReel(Array.from({ length: steps + 1 }, (_, i) => (from + i) % 10));
    setPos(0);
    setDur(0);

    // Paint the reel at the top first, then on the next frame animate it down
    // so the browser actually transitions (rather than snapping to the end).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setPos(steps);
        setDur(ROLL_MS);
      });
    });

    // Once landed, collapse the reel back to a single static digit. The visible
    // window shows the same glyph before and after, so the reset is seamless.
    const settle = setTimeout(() => {
      setReel([digit]);
      setPos(0);
      setDur(0);
    }, ROLL_MS + 60);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(settle);
    };
  }, [digit]);

  return (
    <span className="digit-reel">
      <span
        className="digit-reel-strip"
        style={{
          transform: `translateY(-${pos}em)`,
          transitionProperty: "transform",
          transitionDuration: `${dur}ms`,
          transitionTimingFunction: "var(--ease-out)",
        }}
      >
        {reel.map((d, i) => (
          <span key={i} className="digit-cell">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

/** A non-numeric character that slides its old glyph out and new glyph in. */
function RollingChar({ char }: { char: string }) {
  const [display, setDisplay] = useState(char);
  const [rolling, setRolling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (char === display) return;
    setRolling(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDisplay(char);
      setRolling(false);
      timer.current = null;
    }, ROLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [char, display]);

  const glyph = (c: string) => (c === " " ? NBSP : c);

  if (!rolling) {
    return <span className="roll-col">{glyph(display)}</span>;
  }

  return (
    <span className="roll-col is-rolling">
      <span className="roll-in">{glyph(char)}</span>
      <span className="roll-out" aria-hidden="true">
        {glyph(display)}
      </span>
    </span>
  );
}
