import type { StatusLevel } from "@/domain/status-config";

/**
 * How each status looks. Status is NEVER colour alone: each level also has its own icon SHAPE
 * (see StatusIcon) and a WORD. The colour classes come from the palette tokens in globals.css.
 */
export const STATUS_STYLE: Record<StatusLevel, { word: string; box: string }> = {
  CRITICAL: { word: "Critical", box: "border-status-critical bg-status-critical-bg text-status-critical" },
  LOW: { word: "Low", box: "border-status-low bg-status-low-bg text-status-low" },
  NORMAL: { word: "Normal", box: "border-status-normal bg-status-normal-bg text-status-normal" },
  HIGH: { word: "High", box: "border-status-high bg-status-high-bg text-status-high" },
};
