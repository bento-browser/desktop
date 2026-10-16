import { useEffect, useRef, useState } from 'react';
import Music2 from 'lucide-react/dist/esm/icons/music-2';
import Music3 from 'lucide-react/dist/esm/icons/music-3';
import Music4 from 'lucide-react/dist/esm/icons/music-4';
import { afterMotion } from '../../motion/afterMotion';
import { BentoIcon } from '../primitives/BentoIcon';

const PARTICLE_ICONS = [Music2, Music3, Music4];
const EMIT_INTERVAL_MS = 540;
const PARTICLE_MOTION = { animations: ['bento-workspace-switcher-audio-particle'] };

interface Particle {
  id: number;
  variation: number;
}

/** Floating audio cue shared by the workspace-switcher trigger and menu.
 * Each note owns a finite animation. When audio stops, the interval is cleared
 * but already-emitted notes stay mounted until their own fade-out completes
 * (its animation end, with a timer fallback sized from the computed style). */
export function WorkspaceAudioParticles({
  active,
  variant = 'trigger',
}: {
  active: boolean;
  variant?: 'trigger' | 'menu';
}) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextParticleId = useRef(0);
  const nextVariation = useRef(0);
  const containerRef = useRef<HTMLSpanElement>(null);
  const waitsRef = useRef<Map<number, () => void>>(new Map());

  useEffect(() => {
    if (!active) return;
    const emit = () => {
      const variation = nextVariation.current % PARTICLE_ICONS.length;
      nextVariation.current += 1;
      setParticles((current) => [...current, { id: nextParticleId.current++, variation }]);
    };
    emit();
    const interval = window.setInterval(emit, EMIT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active]);

  // The container's children are the particles, in order. Each one starts a
  // wait for its own animation once it is in the DOM.
  useEffect(() => {
    const container = containerRef.current;
    const waits = waitsRef.current;
    if (!container) return;
    particles.forEach((particle, index) => {
      const note = container.children[index];
      if (!note || waits.has(particle.id)) return;
      let ended = false;
      const cancel = afterMotion(note, PARTICLE_MOTION, () => {
        ended = true;
        waits.delete(particle.id);
        setParticles((current) => current.filter((item) => item.id !== particle.id));
      });
      if (!ended) waits.set(particle.id, cancel);
    });
  }, [particles]);

  useEffect(() => {
    const waits = waitsRef.current;
    return () => {
      for (const cancel of waits.values()) cancel();
      waits.clear();
    };
  }, []);

  if (!active && particles.length === 0) return null;

  return (
    <span
      ref={containerRef}
      className={`bento-workspace-switcher__audio-particles bento-workspace-switcher__audio-particles--${variant}`}
      role="img"
      aria-label={active ? 'Audio playing' : undefined}
      aria-hidden={active ? undefined : true}
    >
      {particles.map((particle) => {
        const ParticleIcon = PARTICLE_ICONS[particle.variation]!;
        const className = `bento-workspace-switcher__audio-particle bento-workspace-switcher__audio-particle--${particle.variation + 1}`;
        return <BentoIcon key={particle.id} icon={ParticleIcon} size="sm" className={className} />;
      })}
    </span>
  );
}
