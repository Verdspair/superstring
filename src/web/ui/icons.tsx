import { Icon } from "../design-system/Icon";

export type { IconName } from "../design-system/Icon";
// Stable feature-facing exports; brand and generic glyphs have separate ownership.
export { Icon } from "../design-system/Icon";
export function NewSessionButtonIcon() {
  return <Icon name="new" className="new-session-icon" />;
}
export function HeadingIcon({ name }: { name: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <span className="heading-icon-host" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}
export function NewSessionDialogIcon() {
  return <HeadingIcon name="new" />;
}
export function Chevron() {
  return <Icon name="chevron" className="chevron" />;
}
