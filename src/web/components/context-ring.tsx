import { buildStyles, CircularProgressbar } from "react-circular-progressbar";
import "react-circular-progressbar/dist/styles.css";

/** A compact capacity ring; its button exposes the full accessible usage label. */
export function ContextRing({ percent }: { percent: number | null }) {
  return (
    <span className="inline-flex size-5 shrink-0" aria-hidden="true">
      <CircularProgressbar
        value={percent ?? 0}
        strokeWidth={10}
        styles={buildStyles({
          pathColor: "var(--primary)",
          trailColor: "var(--border)",
          pathTransitionDuration: 0,
        })}
      />
    </span>
  );
}
