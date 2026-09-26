# Frontend design system

The UI uses the official shadcn/ui `radix-nova` registry with Tailwind CSS 4 and Lucide.
`components.json` is the source of registry configuration. Add primitives with `npx shadcn add`;
compose them in task screens instead of building a parallel component or CSS system.

- `components/ui/`: registry components. Small compatibility changes are limited to accessibility,
  localization, project formatting, and lint integration. The registry and its MIT license are at
  https://github.com/shadcn-ui/ui; the notice is retained in `components/ui/LICENSE.md`. Reference layouts: https://ui.shadcn.com/blocks/sidebar.
- `styles.css`: official neutral light/dark tokens, Tailwind imports, and reduced-motion defaults.
- `appearance.ts`: the existing 16 user themes project into standard primary, ring and sidebar tokens.
- `design-system/BrandLogo.tsx`: original project logo geometry, independent from functional icons.
- `design-system/Icon.tsx`: semantic Lucide names for business components.
- `components/`: small business compositions over registry components (field association, confirmations, context ring).
- `screens/`: fresh task workspaces; `features/` retains state and API actions only.
- `i18n/locales/`: standard i18next JSON catalogs. UI uses `react-i18next` directly.
  Run `npm run check:i18n` (official i18next CLI) before submitting UI changes.
  `notices` preserves state-message compatibility; i18next owns interpolation for both namespaces.
- `services/`: Effect-backed abortable reads and foreground polling, without a second data cache.

Motion handles visual transitions; it never owns mutations, drafts or protected input/output data.
Use standard Tailwind layout utilities and semantic colors. Preserve existing field permissions,
request identities, retry semantics and confirmation behavior when composing a new screen.
