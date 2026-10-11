import { describe, expect, it } from 'vitest';
import { findDuplicateModules, packageOf } from './module-identity-guard';

const rac = '/repo/node_modules/react-aria-components/dist/private/Menu.mjs';

describe('packageOf', () => {
  it('resolves plain and scoped packages from the last node_modules segment', () => {
    expect(packageOf(`${rac}?v=1`)).toEqual({
      name: 'react-aria-components',
      root: '/repo/node_modules/react-aria-components',
    });
    expect(packageOf('\0/repo/node_modules/react/index.js?commonjs-module')).toEqual({
      name: 'react',
      root: '/repo/node_modules/react',
    });
    expect(packageOf('/r/node_modules/a/node_modules/@react-aria/menu/dist/x.mjs')).toEqual({
      name: '@react-aria/menu',
      root: '/r/node_modules/a/node_modules/@react-aria/menu',
    });
    expect(packageOf('/repo/src/main.tsx')).toBeUndefined();
  });
});

describe('findDuplicateModules', () => {
  it('accepts one chunk per module and one install per package', () => {
    expect(
      findDuplicateModules([
        { fileName: 'a.js', moduleIds: [rac, '/repo/src/a.ts'] },
        {
          fileName: 'b.js',
          moduleIds: ['/repo/node_modules/react-aria-components/dist/Other.mjs'],
        },
      ]),
    ).toEqual([]);
  });

  it('reports a module id emitted into two chunks', () => {
    const problems = findDuplicateModules([
      { fileName: 'a.js', moduleIds: [rac] },
      { fileName: 'b.js', moduleIds: [rac] },
    ]);
    expect(problems).toEqual([`${rac} is in both a.js and b.js`]);
  });

  it('reports a context-bearing package bundled from two install paths', () => {
    const nested =
      '/repo/node_modules/@muxui/react/node_modules/react-aria-components/dist/Menu.mjs';
    const problems = findDuplicateModules([
      { fileName: 'a.js', moduleIds: [rac] },
      { fileName: 'b.js', moduleIds: [nested] },
    ]);
    expect(problems).toEqual([
      'react-aria-components is bundled from /repo/node_modules/react-aria-components and ' +
        '/repo/node_modules/@muxui/react/node_modules/react-aria-components',
    ]);
  });

  it('ignores duplicate installs of packages without shared module state', () => {
    expect(
      findDuplicateModules([
        { fileName: 'a.js', moduleIds: ['/repo/node_modules/lucide-react/dist/a.js'] },
        { fileName: 'b.js', moduleIds: ['/repo/extensions/s/node_modules/lucide-react/dist/b.js'] },
      ]),
    ).toEqual([]);
  });
});
