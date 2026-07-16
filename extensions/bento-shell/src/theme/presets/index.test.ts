import { describe, expect, it } from 'vitest';

import { BENTO_THEMES, getThemeMeta } from './index';

describe('workspace theme presets', () => {
  it('includes the complete Tale UI standard and monochromatic collections', () => {
    expect(BENTO_THEMES.filter((theme) => theme.collection === 'standard')).toHaveLength(8);
    expect(BENTO_THEMES.filter((theme) => theme.collection === 'monochrome')).toHaveLength(7);
  });

  it('keeps standard and monochromatic Terracotta distinct', () => {
    expect(getThemeMeta('standard-terracotta').brand60).toBe('#9b3f35');
    expect(getThemeMeta('monochrome-terracotta').brand60).toBe('#a64300');
  });

  it('resolves legacy workspace theme ids to the monochromatic collection', () => {
    expect(getThemeMeta('antique').id).toBe('monochrome-antique');
    expect(getThemeMeta('terracotta').id).toBe('monochrome-terracotta');
  });
});
