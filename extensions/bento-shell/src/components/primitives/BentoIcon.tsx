import type { LucideIcon } from 'lucide-react/dist/lucide-react';
import type { AnimationEventHandler } from 'react';

const ICON_SIZES = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
} as const;

export interface BentoIconProps {
  icon: LucideIcon;
  size?: keyof typeof ICON_SIZES;
  label?: string;
  className?: string;
  strokeWidth?: number;
  onAnimationEnd?: AnimationEventHandler<SVGSVGElement>;
}

/** Small Bento-owned presentation adapter for Lucide icons in Mux pilot UI. */
export function BentoIcon({
  icon: Icon,
  size = 'md',
  label,
  className,
  strokeWidth = 2,
  onAnimationEnd,
}: BentoIconProps) {
  const classes = ['bento-icon', `bento-icon--${size}`, className].filter(Boolean).join(' ');
  return (
    <Icon
      className={classes}
      size={ICON_SIZES[size]}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
      strokeWidth={strokeWidth}
      onAnimationEnd={onAnimationEnd}
    />
  );
}
