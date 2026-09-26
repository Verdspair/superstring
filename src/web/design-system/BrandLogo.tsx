import type { SVGProps } from "react";

/** Original Superstring mark. Keep this geometry independent from the functional icon library. */
export function BrandLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className="icon brand-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        strokeWidth="1.7"
        d="M7.6 10h8.8a1.6 1.6 0 0 1 1.6 1.6V17a1.6 1.6 0 0 1-1.6 1.6h-6.9l-1.9 1.9v-1.9A1.6 1.6 0 0 1 6 17v-5.4A1.6 1.6 0 0 1 7.6 10Z"
      />
      <g strokeWidth="1.3">
        <path d="M1.85 3.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
        <path d="M3.7025 3.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
        <path d="M20.2975 5.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
        <path d="M22.15 5.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
      </g>
      <path
        strokeWidth="1.4"
        d="M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75"
      />
      <circle cx="10.065" cy="13.1" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="13.935" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
