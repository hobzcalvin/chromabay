// Minimal types for the vendored Knob.js gesture engine (jherrm/knobs).
// The implementation is plain JS (knob.js, @ts-nocheck); this only describes the
// surface our RotaryKnob uses.

export interface KnobTouchPoint {
  pageX: number;
  pageY: number;
}

export declare class Knob {
  /** Reads min/max/value + data-* gesture options off `inputEl`. */
  constructor(inputEl: Element, callback?: (knob: Knob, indicator: unknown, spriteOffset: unknown) => void);

  /** Get (no arg) or set (with arg) the current value. */
  val(value?: number): number;
  /** Get or set the current angle. */
  angle(angle?: number): number;

  /** Element page position (left/top), used to compute the rotational center. */
  setPosition(left: number, top: number): void;
  /** Element dimensions, used to compute the rotational center. */
  setDimensions(width: number, height: number): void;

  doTouchStart(touches: KnobTouchPoint[], timeStamp: number): void;
  doTouchMove(touches: KnobTouchPoint[], timeStamp: number, scale?: number): void;
  doTouchEnd(timeStamp: number): void;
  doMouseScroll(wheelDelta: number, timeStamp: number, pageX: number, pageY: number): void;
}
