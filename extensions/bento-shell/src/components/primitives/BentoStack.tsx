import { forwardRef, type HTMLAttributes } from 'react';

import './BentoStack.css';

export type BentoStackDirection = 'row' | 'column';
export type BentoStackGap = '4xs' | '3xs' | '2xs' | 'xs' | 's' | 'm' | 'l';
export type BentoStackAlign = 'center' | 'baseline' | 'end' | 'stretch';
export type BentoStackJustify = 'center' | 'between' | 'end';

export interface BentoStackProps extends HTMLAttributes<HTMLDivElement> {
  direction: BentoStackDirection;
  gap?: BentoStackGap;
  align?: BentoStackAlign;
  justify?: BentoStackJustify;
  wrap?: boolean;
}

export const BentoStack = forwardRef<HTMLDivElement, BentoStackProps>(function BentoStack(
  { direction, gap, align, justify, wrap = false, className, ...props },
  ref,
) {
  const classes = ['bento-stack', `bento-stack--${direction}`, className].filter(Boolean).join(' ');

  return (
    <div
      {...props}
      ref={ref}
      className={classes}
      data-bento-layout={direction}
      data-bento-gap={gap}
      data-bento-align={align}
      data-bento-justify={justify}
      data-bento-wrap={wrap ? 'true' : undefined}
    />
  );
});

BentoStack.displayName = 'BentoStack';
