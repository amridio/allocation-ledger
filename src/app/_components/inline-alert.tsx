import type { ReactNode } from "react";
import { AlertIcon } from "./icons";

/** An error or notice that is announced to screen readers and never relies on colour: icon + words + a heavy border. */
export function InlineAlert({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-3 rounded-xl border-4 border-danger bg-danger-bg p-4 text-lg font-bold text-danger"
    >
      <AlertIcon />
      <div>{children}</div>
    </div>
  );
}
