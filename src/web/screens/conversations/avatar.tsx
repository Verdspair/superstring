import { lazy, Suspense } from "react";
import type { ConversationAvatar as AvatarAsset } from "../../../shared/contracts/conversation-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { cn } from "../../lib/utils";
import { type AvatarIdentity, defaultConversationAvatar } from "./avatar-designs";
import type { AvatarImageStatus } from "./avatar-generated-image";

const generatedImages = {
  shapes: lazy(() => import("./avatar-styles/shapes")),
  rings: lazy(() => import("./avatar-styles/rings")),
  "pixel-art": lazy(() => import("./avatar-styles/pixel-art")),
  lorelei: lazy(() => import("./avatar-styles/lorelei")),
  notionists: lazy(() => import("./avatar-styles/notionists")),
  thumbs: lazy(() => import("./avatar-styles/thumbs")),
};

/** Pure presentation: callers provide shared metadata; absent metadata uses a deterministic local design. */
export function ConversationAvatar({
  conversation,
  value,
  className,
  label = "",
  onImageError,
  onImageStatus,
}: {
  conversation: AvatarIdentity;
  value?: AvatarAsset;
  className?: string;
  label?: string;
  onImageError?: () => void;
  onImageStatus?: (status: AvatarImageStatus) => void;
}) {
  const resolved = value ?? defaultConversationAvatar(conversation);
  const GeneratedImage = resolved.kind === "generated" ? generatedImages[resolved.style] : null;
  const fallback = Array.from(conversation.title.trim()).slice(0, 2).join("") || "·";
  const statusChanged = (status: AvatarImageStatus) => {
    onImageStatus?.(status);
    if (status === "error") onImageError?.();
  };
  return (
    <Avatar
      key={resolved.kind === "generated" ? `${resolved.style}:${resolved.seed}` : resolved.url}
      className={cn("size-10", className)}
    >
      <Suspense fallback={null}>
        {resolved.kind === "generated" && GeneratedImage ? (
          <GeneratedImage
            seed={resolved.seed}
            label={label}
            onLoadingStatusChange={statusChanged}
          />
        ) : resolved.kind === "uploaded" ? (
          <AvatarImage src={resolved.url} alt={label} onLoadingStatusChange={statusChanged} />
        ) : null}
      </Suspense>
      <AvatarFallback className="bg-primary/10 text-primary" aria-hidden={!label}>
        {fallback}
      </AvatarFallback>
    </Avatar>
  );
}
