import type { SVGProps } from "react";
import brandAsset from "../../shared/brand/superstring.svg?no-inline";

/** One vector master is shared with the favicon and desktop build. */
export function BrandLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className="icon brand-mark"
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <use href={`${brandAsset}#mark`} />
    </svg>
  );
}
