export function findClosingBrace(css: string, openIndex: number): number;
export function splitTopLevelBlocks(css: string): { prelude: string; body: string }[];
export function unwrapTopLevelLayers(css: string): string;
export function themeIdsInSelector(selector: string): string[];
