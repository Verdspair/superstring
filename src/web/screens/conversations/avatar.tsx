import { MessageCircle, Users } from "lucide-react";
import { lazy, Suspense } from "react";
import type { ConversationAvatar as AvatarAsset } from "../../../shared/contracts/conversation-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { cn } from "../../lib/utils";
import type { AvatarIdentity } from "./avatar-designs";
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
  if (value == null) {
    const Icon = conversation.topology === "shared" ? Users : MessageCircle;
    return (
      <Avatar
        className={cn("size-10 border border-border bg-primary/8 text-primary", className)}
        role={label ? "img" : undefined}
        aria-label={label || undefined}
        aria-hidden={!label}
      >
        <span className="flex size-full items-center justify-center bg-primary/8">
          <Icon aria-hidden="true" className="size-[52%] stroke-[1.5]" />
        </span>
      </Avatar>
    );
  }
  const resolved = value;
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
