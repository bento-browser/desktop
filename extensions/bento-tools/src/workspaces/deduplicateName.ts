/** An imported workspace's name, suffixed `(imported)` or `(N)` when it is already taken. */
export function deduplicateName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const suffixed = `${name} (imported)`;
  if (!existing.has(suffixed)) return suffixed;
  let i = 2;
  while (existing.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}
