import { useEffect, useRef } from 'react';
import type { SoftcastPresentation } from './softcast';

export function SoftcastIcon({ icon, loading }: { icon: SoftcastPresentation; loading: boolean }) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (!element || !icon.spin) return;
    let inView = false;
    const update = () => {
      element.dataset.running = String(inView && !document.hidden);
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      element.dataset.running = 'false';
    };
  }, [icon.spin]);

  return (
    <img
      ref={image}
      className={
        'bento-tab-row__favicon bento-tab-row__softcast' +
        (icon.spin ? ' bento-tab-row__softcast--spin' : '')
      }
      data-softcast-state={icon.state}
      data-running="false"
      src={icon.src}
      alt={loading ? '' : icon.label}
      role={loading ? 'progressbar' : undefined}
      aria-label={loading ? 'Loading' : undefined}
      draggable={false}
    />
  );
}
