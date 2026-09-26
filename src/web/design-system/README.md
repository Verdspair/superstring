# Frontend design system

The UI uses the official shadcn/ui `radix-nova` registry with Tailwind CSS 4 and Lucide.
`components.json` is the source of registry configuration. Add primitives with `npx shadcn add`;
compose them in feature modules instead of building a parallel component or CSS system.

- `components/ui/`: registry components. Small compatibility changes are limited to accessibility,
  localization, project formatting, and lint integration. The registry and its MIT license are at
  https://github.com/shadcn-ui/ui. Reference layouts: https://ui.shadcn.com/blocks/sidebar.
- `styles.css`: official neutral light/dark tokens, Tailwind imports, and reduced-motion defaults.
- `appearance.ts`: the existing 16 user themes project into standard primary, ring and sidebar tokens.
- `design-system/BrandLogo.tsx`: original project logo geometry, independent from functional icons.
- `design-system/Icon.tsx`: semantic Lucide names for business components.
- `ui/`: business compositions over the registry components (fields, settings groups, confirmations).
- `services/`: Effect-backed abortable reads and foreground polling, without a second data cache.

Motion handles visual transitions; it never owns mutations, drafts or protected input/output data.
Use standard Tailwind layout utilities and semantic colors. Preserve existing field permissions,
request identities, retry semantics and confirmation behavior when composing a new screen.
