// Minimal DOM doubles for the theme-sheet tests (vitest runs in node, without a document).
// Only the surface themeSheets.ts, applyRootTheme.ts, and public/boot.js touch is modelled.

type Listener = () => void;

export class FakeLink {
  rel = '';
  href = '';
  dataset: Record<string, string> = {};
  /** Null until loaded, like the real property; tests assign a stub to model a loaded sheet. */
  sheet: { cssRules: unknown[] } | null = null;
  removed = false;
  private listeners = new Map<string, Listener>();

  constructor(private head: FakeHead) {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  /** `data-foo-bar` attributes live in `dataset.fooBar`, as in a real element. */
  setAttribute(name: string, value: string) {
    this.dataset[toDatasetKey(name)] = value;
  }

  hasAttribute(name: string) {
    return toDatasetKey(name) in this.dataset;
  }

  remove() {
    this.removed = true;
    this.head.links.delete(this);
  }

  fire(type: 'load' | 'error') {
    this.listeners.get(type)?.();
  }
}

function toDatasetKey(attribute: string): string {
  return attribute
    .replace(/^data-/, '')
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export class FakeHead {
  links = new Set<FakeLink>();

  append(link: FakeLink) {
    this.links.add(link);
  }

  appendChild(link: FakeLink) {
    this.append(link);
  }

  /** Supports the one selector themeSheets.ts uses: the link public/boot.js inserted. */
  querySelector(selector: string): FakeLink | null {
    if (selector !== 'link[data-bento-boot-sheet]') throw new Error(`unsupported: ${selector}`);
    return [...this.links].find((link) => link.dataset.bentoBootSheet !== undefined) ?? null;
  }

  get hrefs() {
    return [...this.links].map((link) => link.href);
  }
}

export class FakeRoot {
  attributes = new Map<string, string>();
  /** Inline custom properties, as set through `style.setProperty`. */
  properties = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => {
      this.properties.set(name, value);
    },
  };

  hasAttribute(name: string) { return this.attributes.has(name); }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

/** A fake `document`; `currentScript` stands in for boot.js's own <script> element. */
export function createFakeDocument(
  currentScript: { hasAttribute(name: string): boolean } | null = null,
) {
  const head = new FakeHead();
  const documentElement = new FakeRoot();
  return {
    head,
    documentElement,
    document: {
      head,
      documentElement,
      currentScript,
      createElement: () => new FakeLink(head),
    },
  };
}

/** Insert a link the way public/boot.js does, optionally already past its load or error. */
export function insertBootLink(
  head: FakeHead,
  themeId: string,
  marker: 'loading' | 'loaded' | 'failed' = 'loading',
): FakeLink {
  const link = new FakeLink(head);
  link.rel = 'stylesheet';
  link.href = `./themes/${themeId}.css`;
  link.dataset.bentoThemeSheet = themeId;
  link.dataset.bentoBootSheet = marker;
  head.append(link);
  return link;
}

/** Map-backed localStorage double. */
export function createFakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}
