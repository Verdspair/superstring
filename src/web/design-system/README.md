# Frontend design system

- `BrandLogo` contains the original product mark; functional icons never replace it.
- `Icon` is the only Lucide mapping. Feature components name the intent (`chat`, `memory`, `refresh`) instead of copying SVG paths. `ui/icons.tsx` keeps the existing feature-facing exports.
- `DesignSystemProvider` sets reduced-motion and tooltip policy. Animation only affects presentation; it must not delay state updates or retain revoked payloads.
- `IconButton` combines a named native button and Radix tooltip. The label is always available to assistive technology.
- `styles/` separates semantic tokens, controls, shell and feature presentation. Theme colors change accents; they do not redefine the meaning of success or failure.
- Complex interactions use Radix primitives, and command search uses cmdk. Native inputs and semantic lists remain appropriate when they already supply the required interaction.
- Domain state stays in the existing feature/store owners. Effect resource owners in `services/` handle cancellable reads; they do not cache protected text or retry writes.

Before adding a component, choose its semantic role, state owner, keyboard behavior, narrow layout and existing primitive. Add a reusable component only when it carries a shared responsibility; avoid empty abstraction layers and page-specific variants in global primitives.
