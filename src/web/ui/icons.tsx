import type { ReactNode } from "react";

export function Icon({
  name,
}: {
  name:
    | "brand"
    | "settings"
    | "chat"
    | "agent"
    | "memory"
    | "context"
    | "persona"
    | "emotion"
    | "plug"
    | "more"
    | "sliders"
    | "users"
    | "back"
    | "palette"
    | "profile"
    | "plus"
    | "instructions"
    | "chip"
    | "search"
    | "archive"
    | "clock"
    | "hand"
    | "compress"
    | "shield"
    | "scope"
    | "book"
    | "language"
    | "trash"
    | "edit"
    | "refresh";
}) {
  const paths: Record<typeof name, ReactNode> = {
    edit: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />,
    book: (
      <>
        <path d="M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z" />
      </>
    ),
    language: (
      <>
        <path d="M3 5h12M9 3v2M5 5c1 5 4 8 9 10M13 5c-1 5-4 8-9 10M14 21l4-11 4 11M16 17h4" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    instructions: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    chip: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    archive: (
      <>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v12h14V8M10 12h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    hand: (
      <path d="M9 12V5a2 2 0 0 1 4 0v6l1-1a2 2 0 0 1 3 1l1-1a2 2 0 0 1 3 2v3a6 6 0 0 1-6 6h-2a5 5 0 0 1-4-2l-5-6a2 2 0 0 1 3-2l2 2" />
    ),
    compress: (
      <>
        <path d="M4 4l5 5M4 9h5V4M20 20l-5-5m0 5v-5h5M14 4h6v6M4 14v6h6" />
      </>
    ),
    shield: <path d="M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Zm-4 9 3 3 5-6" />,
    scope: (
      <>
        <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    brand: (
      <>
        <path
          strokeWidth="1.7"
          d="M7.6 10h8.8a1.6 1.6 0 0 1 1.6 1.6V17a1.6 1.6 0 0 1-1.6 1.6h-6.9l-1.9 1.9v-1.9A1.6 1.6 0 0 1 6 17v-5.4A1.6 1.6 0 0 1 7.6 10Z"
        />
        <g strokeWidth="1.3">
          <path d="M1.85 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
          <path d="M3.7025 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
          <path d="M20.2975 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
          <path d="M22.15 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
        </g>
        <path
          strokeWidth="1.4"
          d="M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75"
        />
        <circle cx="10.065" cy="13.1" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="13.935" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
    settings: (
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.73v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.73l.15-.1a2 2 0 0 0 .73-2.72l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      </>
    ),
    chat: (
      <>
        <path d="M4 5.5h16v11H9l-5 3v-14Z" />
        <path d="M8 10h8M8 13h5" />
      </>
    ),
    agent: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20v-1a7 7 0 0 1 14 0v1" />
      </>
    ),
    memory: (
      <>
        <path d="M5 6c0-2 3.1-3 7-3s7 1 7 3-3.1 3-7 3-7-1-7-3Z" />
        <path d="M5 6v6c0 2 3.1 3 7 3s7-1 7-3V6M5 12v6c0 2 3.1 3 7 3s7-1 7-3v-6" />
      </>
    ),
    context: (
      <>
        <path d="M4 5h16v12H9l-5 3V5Z" />
        <path d="M8 9h8M8 13h6" />
      </>
    ),
    persona: (
      <>
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </>
    ),
    emotion: (
      <>
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
        <path d="M8.5 10h.01M15.5 10h.01M8.5 15c2 1.5 5 1.5 7 0" />
      </>
    ),
    plug: (
      <>
        <path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-6 6v4M9 21h6" />
      </>
    ),
    more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
    sliders: (
      <>
        <path d="M4 7h4m4 0h8M4 17h8m4 0h4" />
        <circle cx="10" cy="7" r="2" />
        <circle cx="14" cy="17" r="2" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v1" />
      </>
    ),
    back: <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />,
    palette: (
      <>
        <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" />
        <circle cx="7.5" cy="11" r="0.7" />
        <circle cx="10" cy="7" r="0.7" />
        <circle cx="15" cy="7.5" r="0.7" />
      </>
    ),
    profile: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <circle cx="9" cy="10" r="2" />
        <path d="M5.5 16a3.5 3.5 0 0 1 7 0M15 9h3m-3 4h3" />
      </>
    ),
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function NewSessionButtonIcon() {
  return (
    <svg className="new-session-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

export function HeadingIcon({ name }: { name: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <span className="heading-icon-host" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}

export function NewSessionDialogIcon() {
  return (
    <span className="heading-icon-host" aria-hidden="true">
      <svg className="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14v12H9l-4 4V4Z" />
        <path d="M12 7v6M9 10h6" />
      </svg>
    </span>
  );
}

export function Chevron() {
  return (
    <svg className="icon chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
