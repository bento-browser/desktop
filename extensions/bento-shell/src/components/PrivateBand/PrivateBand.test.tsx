import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_BAND_SUMMARY,
  PRIVATE_BAND_TITLE,
  PRIVATE_NOTE_BODY,
  PRIVATE_NOTE_TITLE,
  PrivateBand,
} from './PrivateBand';

describe('PrivateBand', () => {
  it('expanded, reads Private over the summary and is a popover trigger', () => {
    const markup = renderToStaticMarkup(<PrivateBand />);
    expect(markup).toContain(PRIVATE_BAND_TITLE);
    expect(markup).toContain(PRIVATE_BAND_SUMMARY);
    expect(markup).toContain('aria-expanded="false"');
    // The note is not in the page until the band is activated.
    expect(markup).not.toContain(PRIVATE_NOTE_BODY);
  });

  it('in the rail, is named by the note and draws no popover', () => {
    const markup = renderToStaticMarkup(<PrivateBand rail />);
    expect(markup).toContain(`aria-label="${PRIVATE_NOTE_TITLE}. ${PRIVATE_NOTE_BODY}"`);
    expect(markup).not.toContain('aria-expanded');
  });
});
