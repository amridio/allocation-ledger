import type { OutboxNotice } from "@/ui/outbox";
import { BTN_SECONDARY } from "@/ui/styles";
import { AlertIcon } from "./icons";

/**
 * Errors for allocations the server rejected and the screen rolled back. They stay until dismissed and
 * float at the top while scrolling, so a rejection is never missed. Icon + words + a heavy border, never colour alone.
 */
export function NoticeList({ notices, onDismiss }: { notices: OutboxNotice[]; onDismiss: (key: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="sticky top-2 z-20 mt-4 flex flex-col gap-3" data-testid="notices">
      {notices.map((n) => (
        <div
          key={n.key}
          role="alert"
          data-testid="notice"
          className="flex flex-col gap-3 rounded-xl border-4 border-danger bg-danger-bg p-4 text-danger shadow-lg"
        >
          <div className="flex items-start gap-3">
            <AlertIcon />
            <div>
              <p className="text-xl font-extrabold">
                Not logged: {n.units} unit{n.units === 1 ? "" : "s"}
              </p>
              <p className="text-lg font-bold">{n.message}</p>
              <p className="text-lg font-bold">Your total was put back as it was.</p>
            </div>
          </div>
          <button type="button" data-testid="dismiss-notice" onClick={() => onDismiss(n.key)} className={BTN_SECONDARY}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
