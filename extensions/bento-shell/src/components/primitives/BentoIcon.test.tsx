import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Check from 'lucide-react/dist/esm/icons/check';

import { BentoIcon } from './BentoIcon';

describe('BentoIcon', () => {
  it('preserves pilot sizing and presentation attributes with the default stroke', () => {
    const markup = renderToStaticMarkup(
      <BentoIcon icon={Check} size="sm" label="Active" className="custom-icon" />,
    );

    expect(markup).toContain('bento-icon bento-icon--sm custom-icon');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toContain('aria-label="Active"');
    expect(markup).toContain('focusable="false"');
  });

  it('forwards an explicit stroke width for the heavier picker icon treatment', () => {
    const markup = renderToStaticMarkup(<BentoIcon icon={Check} strokeWidth={3} />);

    expect(markup).toContain('stroke-width="3"');
  });
});
