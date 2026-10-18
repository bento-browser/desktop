import { describe, expect, it } from 'vitest';
import { matchesTabSearch, searchResultDomain } from './tabSearch';

describe('matchesTabSearch', () => {
  it('matches the title case-insensitively', () => {
    expect(matchesTabSearch('google.com', 'Notes about Google.com', 'https://example.org/')).toBe(
      true,
    );
  });

  it('matches the URL host, including subdomains', () => {
    expect(matchesTabSearch('google.com', 'Search', 'https://www.google.com/search?q=x')).toBe(
      true,
    );
    expect(matchesTabSearch('google.com', 'Mail', 'https://mail.google.com/mail/u/0/')).toBe(true);
  });

  it('matches the URL path', () => {
    expect(matchesTabSearch('github.com/andrew', 'Repo', 'https://github.com/andrew/repo')).toBe(
      true,
    );
  });

  it('ignores the URL scheme', () => {
    expect(matchesTabSearch('https', 'Docs', 'https://example.org/')).toBe(false);
    expect(matchesTabSearch('about', 'Blank', 'about:blank')).toBe(false);
    expect(matchesTabSearch('moz-extension', 'Page', 'moz-extension://abc/page.html')).toBe(false);
  });

  it('ignores a query scheme:// or about: prefix, so a pasted full URL finds its tab', () => {
    expect(
      matchesTabSearch('https://github.com/andrew', 'Repo', 'https://github.com/andrew/repo'),
    ).toBe(true);
    expect(matchesTabSearch('about:blank', 'New', 'about:blank')).toBe(true);
    expect(matchesTabSearch('file:///users/me/a.html', 'A', 'file:///Users/me/a.html')).toBe(true);
    expect(matchesTabSearch('https://github.com/other', 'Repo', 'https://github.com/andrew')).toBe(
      false,
    );
  });

  it('reads host:port in the query as a host, not a scheme', () => {
    expect(matchesTabSearch('localhost:3000', 'App', 'http://localhost:3000/')).toBe(true);
    expect(matchesTabSearch('localhost:3000', 'Item', 'https://example.com/items/3000')).toBe(
      false,
    );
    expect(matchesTabSearch('http://localhost:3000', 'App', 'http://localhost:3000/')).toBe(true);
  });

  it('does not match on the URL when the query is only a scheme', () => {
    expect(matchesTabSearch('https://', 'Docs', 'https://example.org/')).toBe(false);
    expect(matchesTabSearch('about:', 'Blank', 'about:blank')).toBe(false);
  });

  it('still matches a scheme-only query against the title', () => {
    expect(matchesTabSearch('https://', 'Why https:// matters', 'https://example.org/')).toBe(true);
  });

  it('skips data: URLs, so only the title matches', () => {
    expect(matchesTabSearch('hello', 'Page', 'data:text/html,hello')).toBe(false);
    expect(matchesTabSearch('hello', 'Page', 'DATA:text/html,hello')).toBe(false);
    expect(matchesTabSearch('hello', 'Hello page', 'data:text/html,x')).toBe(true);
  });

  it('falls back to the title when the URL is missing or empty', () => {
    expect(matchesTabSearch('docs', 'Docs', undefined)).toBe(true);
    expect(matchesTabSearch('docs', 'Docs', '')).toBe(true);
    expect(matchesTabSearch('docs', 'Inbox', '')).toBe(false);
  });
});

describe('searchResultDomain', () => {
  it('returns the exact hostname for http and https URLs, keeping www', () => {
    expect(searchResultDomain('https://mail.google.com/mail/u/0/')).toBe('mail.google.com');
    expect(searchResultDomain('http://www.example.org:8080/a?b=c')).toBe('www.example.org');
    expect(searchResultDomain('https://user:pass@example.org/')).toBe('example.org');
  });

  it('returns about: URLs as-is', () => {
    expect(searchResultDomain('about:blank')).toBe('about:blank');
    expect(searchResultDomain('about:preferences#privacy')).toBe('about:preferences#privacy');
  });

  it('treats the scheme case-insensitively', () => {
    expect(searchResultDomain('HTTPS://Mail.Google.com/')).toBe('mail.google.com');
    expect(searchResultDomain('DATA:text/html,hi')).toBeUndefined();
  });

  it('returns nothing for other schemes, empty, missing or unparsable URLs', () => {
    expect(searchResultDomain('moz-extension://abc/page.html')).toBeUndefined();
    expect(searchResultDomain('data:text/html,hi')).toBeUndefined();
    expect(searchResultDomain('blob:https://example.org/uuid')).toBeUndefined();
    expect(searchResultDomain('file:///Users/me/a.html')).toBeUndefined();
    expect(searchResultDomain('')).toBeUndefined();
    expect(searchResultDomain(undefined)).toBeUndefined();
    expect(searchResultDomain('not a url')).toBeUndefined();
  });
});
