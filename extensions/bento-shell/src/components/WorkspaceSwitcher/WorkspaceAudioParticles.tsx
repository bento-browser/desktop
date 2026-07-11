import { useEffect, useRef, useState } from 'react';
import { Icon } from '@tale-ui/react/icon';
import Music2 from 'lucide-react/dist/esm/icons/music-2';
import Music3 from 'lucide-react/dist/esm/icons/music-3';
import Music4 from 'lucide-react/dist/esm/icons/music-4';

const PARTICLE_ICONS = [Music2, Music3, Music4];
const EMIT_INTERVAL_MS = 540;

interface Particle {
  id: number;
  variation: number;
}

/** Floating audio cue shared by the workspace-switcher trigger and menu.
 * Each note owns a finite animation. When audio stops, the interval is cleared
 * but already-emitted notes stay mounted until their own fade-out completes. */
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

  if (!active && particles.length === 0) return null;

  return (
    <span
      className={`bento-workspace-switcher__audio-particles bento-workspace-switcher__audio-particles--${variant}`}
      role="img"
      aria-label={active ? 'Audio playing' : undefined}
      aria-hidden={active ? undefined : true}
    >
      {particles.map((particle) => {
        const ParticleIcon = PARTICLE_ICONS[particle.variation]!;
        return (
          <Icon
            key={particle.id}
            icon={ParticleIcon}
            size="sm"
            className={`bento-workspace-switcher__audio-particle bento-workspace-switcher__audio-particle--${particle.variation + 1}`}
            onAnimationEnd={() => {
              setParticles((current) => current.filter((item) => item.id !== particle.id));
            }}
          />
        );
      })}
    </span>
  );
}
