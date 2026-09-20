import { forwardRef } from 'react';

import {
  BentoStack,
  type BentoStackAlign,
  type BentoStackGap,
  type BentoStackJustify,
  type BentoStackProps,
} from './BentoStack';

export type BentoColumnGap = Extract<BentoStackGap, '4xs' | '3xs' | '2xs' | 'xs' | 's' | 'm' | 'l'>;
export type BentoColumnAlign = Extract<BentoStackAlign, 'stretch'>;
export type BentoColumnJustify = Extract<BentoStackJustify, 'center'>;

export interface BentoColumnProps extends Omit<
  BentoStackProps,
  'direction' | 'gap' | 'align' | 'justify' | 'wrap'
> {
  gap?: BentoColumnGap;
  align?: BentoColumnAlign;
  justify?: BentoColumnJustify;
}

export const BentoColumn = forwardRef<HTMLDivElement, BentoColumnProps>(function BentoColumn(
  { gap = 'm', align = 'stretch', className, ...props },
  ref,
) {
  return (
    <BentoStack
      {...props}
      ref={ref}
      direction="column"
      gap={gap}
      align={align}
      className={['bento-column', className].filter(Boolean).join(' ')}
    />
  );
});

BentoColumn.displayName = 'BentoColumn';

/** Alias for consumers that use the layout primitive name directly. */
export const Column = BentoColumn;
