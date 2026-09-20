import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { BentoColumn } from './BentoColumn';
import { BentoRow } from './BentoRow';

describe('Bento layout primitives', () => {
  it('keeps Row props, attributes, and token spacing observable', () => {
    const onKeyDown = () => undefined;
    const rowRef = createRef<HTMLDivElement>();
    const markup = renderToStaticMarkup(
      <BentoRow
        ref={rowRef}
        gap="4xs"
        align="baseline"
        justify="between"
        wrap
        id="row"
        className="custom-row"
        aria-label="Toolbar"
        data-test-id="row"
        style={{ minWidth: 0 }}
        onKeyDown={onKeyDown}
      >
        <span>Item</span>
      </BentoRow>,
    );

    expect(markup).toContain('class="bento-stack bento-stack--row bento-row custom-row"');
    expect(markup).toContain('data-bento-layout="row"');
    expect(markup).toContain('data-bento-gap="4xs"');
    expect(markup).toContain('data-bento-align="baseline"');
    expect(markup).toContain('data-bento-justify="between"');
    expect(markup).toContain('data-bento-wrap="true"');
    expect(markup).toContain('aria-label="Toolbar"');
    expect(markup).toContain('data-test-id="row"');
    expect(markup).toContain('style="min-width:0"');

    const row = <BentoRow ref={rowRef} onKeyDown={onKeyDown} data-test-id="row" />;
    expect(row.props.onKeyDown).toBe(onKeyDown);
  });

  it('keeps Column defaults and its allowed spacing token observable', () => {
    const markup = renderToStaticMarkup(
      <BentoColumn gap="l" aria-label="Content">
        <span>Item</span>
      </BentoColumn>,
    );

    expect(markup).toContain('class="bento-stack bento-stack--column bento-column"');
    expect(markup).toContain('data-bento-layout="column"');
    expect(markup).toContain('data-bento-gap="l"');
    expect(markup).toContain('data-bento-align="stretch"');
    expect(markup).not.toContain('data-bento-justify=');
    expect(markup).toContain('aria-label="Content"');
  });

  it('matches Bento Row and Column defaults for current consumers', () => {
    const rowMarkup = renderToStaticMarkup(<BentoRow />);
    const columnMarkup = renderToStaticMarkup(<BentoColumn />);

    expect(rowMarkup).toContain('data-bento-gap="m"');
    expect(rowMarkup).toContain('data-bento-align="center"');
    expect(rowMarkup).not.toContain('data-bento-justify=');
    expect(rowMarkup).not.toContain('data-bento-wrap=');

    expect(columnMarkup).toContain('data-bento-gap="m"');
    expect(columnMarkup).toContain('data-bento-align="stretch"');
    expect(columnMarkup).not.toContain('data-bento-justify=');
    expect(columnMarkup).not.toContain('data-bento-wrap=');
  });
});
