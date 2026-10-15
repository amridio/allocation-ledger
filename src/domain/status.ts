import { STATUS_CUTOFFS, type StatusLevel } from "./status-config";

export function statusForActiveUnits(activeUnits: number): StatusLevel {
  if (activeUnits >= STATUS_CUTOFFS.HIGH) return "HIGH";
  if (activeUnits >= STATUS_CUTOFFS.NORMAL) return "NORMAL";
  if (activeUnits >= STATUS_CUTOFFS.LOW) return "LOW";
  return "CRITICAL";
}
