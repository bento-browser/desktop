import type { Plugin } from 'postcss';

export function selectorRequiresContrastMore(selector: string): boolean;
export function dropContrastMoreSelectors(selectorList: string): string;
export const stripContrastMore: Plugin;
