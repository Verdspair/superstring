# Conversation avatars

Conversation avatars use the official [DiceBear JavaScript library](https://www.dicebear.com/how-to-use/js-library/), imported from `@dicebear/core` (MIT). Only these six official style definitions are imported from `@dicebear/styles`; there is no runtime HTTP request to DiceBear or another avatar service.

| Style | Creator | License | Official style reference |
|---|---|---|---|
| Shapes | DiceBear | CC0 1.0 | https://www.dicebear.com/styles/shapes/ |
| Rings | DiceBear | CC0 1.0 | https://www.dicebear.com/styles/rings/ |
| Pixel Art | DiceBear | CC0 1.0 | https://www.dicebear.com/styles/pixel-art/ |
| Lorelei | Lisa Wischofsky | CC0 1.0 | https://www.dicebear.com/styles/lorelei/ |
| Notionists | Zoish | CC0 1.0 | https://www.dicebear.com/styles/notionists/ |
| Thumbs | DiceBear | CC0 1.0 | https://www.dicebear.com/styles/thumbs/ |

[CC0 1.0 legal terms](https://creativecommons.org/publicdomain/zero/1.0/). The upstream style metadata contains the original artwork sources and license notices; DiceBear includes this metadata in generated SVGs. Package versions are pinned in the dependency lockfile so a routine page refresh does not change a seeded design.

## Ownership

- DiceBear owns artwork generation and seeded variation; no custom avatar drawing engine.
- Radix/shadcn owns Avatar image fallback, Dialog focus, Tabs, and RadioGroup keyboard selection.
- The browser owns file picking and image decoding. Preview uses a local object URL, revoked on replacement or editor close. Uploaded files are only sent to the application's own service on Save.
- The editor owns its temporary selection, busy/error state and preview. The server owns saved conversation metadata. Reset commits `null`, allowing a stable conversation-derived default to render again.
- Default designs use the full immutable conversation id as the seed. Editing a title or refreshing the directory does not change the avatar. Saved metadata does not alter the binding epoch or conversation behavior.
