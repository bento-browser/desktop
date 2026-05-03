// lucide-react ships types only for the barrel entry. Per-icon imports
// (which we use to keep bundle weight down per §6.2) lack type declarations.
// This shim re-uses the barrel's component type for any per-icon path.

declare module 'lucide-react/dist/esm/icons/*' {
  // Inline the relevant lucide type so we don't need to barrel-import
  // from 'lucide-react' (which the eslint rule blocks for source files).
  type LucideIconLike = import('react').ForwardRefExoticComponent<
    Omit<import('react').SVGProps<SVGSVGElement>, 'ref'> & {
      size?: number | string;
      absoluteStrokeWidth?: boolean;
      strokeWidth?: number | string;
      color?: string;
    } & import('react').RefAttributes<SVGSVGElement>
  >;
  const Icon: LucideIconLike;
  export default Icon;
}
