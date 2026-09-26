import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import { useMemo } from "react";
import { AvatarImage } from "../../components/ui/avatar";

export type AvatarImageStatus = "idle" | "loading" | "loaded" | "error";
export type GeneratedAvatarImageProps = {
  seed: string;
  label: string;
  onLoadingStatusChange?: (status: AvatarImageStatus) => void;
};
/** Each lazy style module uses the same official renderer; React owns loading and module reuse. */
export function createGeneratedAvatarImage(definition: unknown) {
  const style = new Style(definition);
  return function GeneratedAvatarImage({
    seed,
    label,
    onLoadingStatusChange,
  }: GeneratedAvatarImageProps) {
    const src = useMemo(
      () =>
        new DiceBearAvatar(style, {
          seed,
          size: 160,
          backgroundColor: ["#dbeafe", "#ede9fe", "#e0f2fe", "#fce7f3", "#ecfccb", "#ffedd5"],
        }).toDataUri(),
      [seed],
    );
    return <AvatarImage src={src} alt={label} onLoadingStatusChange={onLoadingStatusChange} />;
  };
}
