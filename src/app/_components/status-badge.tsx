import type { StatusLevel } from "@/domain/status-config";
import { STATUS_STYLE } from "@/ui/status-style";
import { StatusIcon } from "./icons";

/** Status as colour AND icon shape AND a word. Never colour alone. */
export function StatusBadge({ level, size = "md", testId }: { level: StatusLevel; size?: "md" | "lg"; testId?: string }) {
  const style = STATUS_STYLE[level];
  const big = size === "lg";
  return (
    <span
      data-status={level}
      data-testid={testId}
      className={`inline-flex items-center gap-3 rounded-xl border-4 font-extrabold ${style.box} ${
        big ? "px-5 py-3 text-3xl" : "px-3 py-1 text-lg"
      }`}
    >
      <StatusIcon level={level} className={big ? "h-10 w-10" : "h-7 w-7"} />
      <span>{style.word}</span>
    </span>
  );
}
