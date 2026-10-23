// The slider of a slider page: a native range input for semantics, focus, keys and pointer input
// (a recorded exception to the layering rule, docs/mux-ui-component-customisations.md), with the
// track, fill and thumb drawn as elements of our own. A native thumb cannot be transitioned, so
// the input is full size and invisible, and the drawn thumb and fill move with `transform` from
// one custom property, `--bento-slider-ratio` (0 to 1), on the motion `state` pair: they glide
// between values on a key press and on a track click, and follow the pointer without a transition
// while the handle is dragged (a transition per step would leave the drawn thumb behind the native
// one, which is what the pointer hits).

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

export interface RangeSliderProps {
  /** The input, for the page to put the focus on it. */
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  describedBy?: string;
  min: number;
  max: number;
  value: number;
  /** What a screen reader says for the value, with its unit ("12 px"). */
  valueText: string;
  onChange(value: number): void;
  /** Enter keeps the value. */
  onEnter(): void;
}

/** How far a pressed pointer must travel before the press is a drag and not a click on the track. */
const DRAG_SLOP_PX = 3;

/** The thumb's place along its travel, as a custom property for the stylesheet. */
function ratioStyle(ratio: number): CSSProperties & Record<`--${string}`, number> {
  return { '--bento-slider-ratio': ratio };
}

export default function RangeSlider({
  inputRef,
  label,
  describedBy,
  min,
  max,
  value,
  valueText,
  onChange,
  onEnter,
}: RangeSliderProps) {
  // The first paint, and the value the page then settles on, do not glide: movement is switched
  // on a frame after the slider mounts.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // A press that travels past the slop is a drag until the pointer is released. The listeners are
  // on the window: the range input keeps the pointer while it is dragged.
  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<() => void>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  const onPointerDown = (event: PointerEvent<HTMLInputElement>) => {
    if (event.button !== 0) return;
    stopDrag.current?.();
    const { clientX, clientY } = event;
    const view = event.currentTarget.ownerDocument.defaultView ?? window;
    const move = (next: globalThis.PointerEvent) => {
      if (Math.hypot(next.clientX - clientX, next.clientY - clientY) > DRAG_SLOP_PX) {
        setDragging(true);
      }
    };
    const end = () => stopDrag.current?.();
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    stopDrag.current = () => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', end);
      view.removeEventListener('pointercancel', end);
      stopDrag.current = undefined;
      setDragging(false);
    };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };

  return (
    <div
      className="bento-settings-palette__slider"
      data-settled={settled ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      style={ratioStyle((value - min) / (max - min))}
    >
      <div className="bento-settings-palette__slider-track" aria-hidden="true">
        <div className="bento-settings-palette__slider-fill" />
      </div>
      <div className="bento-settings-palette__slider-thumb" aria-hidden="true" />
      <input
        ref={inputRef}
        type="range"
        className="bento-settings-palette__slider-input"
        aria-label={label}
        aria-describedby={describedBy}
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}
