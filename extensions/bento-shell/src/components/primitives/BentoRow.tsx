import { forwardRef } from 'react';

import {
  BentoStack,
  type BentoStackAlign,
  type BentoStackGap,
  type BentoStackJustify,
  type BentoStackProps,
} from './BentoStack';

export type BentoRowGap = Extract<BentoStackGap, '4xs' | '2xs' | 'xs' | 's' | 'm'>;
export type BentoRowAlign = Extract<BentoStackAlign, 'center' | 'baseline' | 'end' | 'stretch'>;
export type BentoRowJustify = Extract<BentoStackJustify, 'center' | 'between' | 'end'>;

export interface BentoRowProps extends Omit<
  BentoStackProps,
  'direction' | 'gap' | 'align' | 'justify' | 'wrap'
> {
  gap?: BentoRowGap;
  align?: BentoRowAlign;
  justify?: BentoRowJustify;
  wrap?: boolean;
}

export const BentoRow = forwardRef<HTMLDivElement, BentoRowProps>(function BentoRow(
  { gap = 'm', align = 'center', className, ...props },
  ref,
) {
  return (
    <BentoStack
      {...props}
      ref={ref}
      direction="row"
      gap={gap}
      align={align}
      className={['bento-row', className].filter(Boolean).join(' ')}
    />
  );
});

BentoRow.displayName = 'BentoRow';

/** Alias for consumers that use the layout primitive name directly. */
export const Row = BentoRow;
