import { BTN_PRIMARY } from "@/ui/styles";
import { PlusIcon } from "./icons";

/** Mobile only: the big button pinned to the bottom edge, inside the phone's safe area. */
export function StickyActionBar({ onClick }: { onClick: () => void }) {
  return (
    <div
      data-testid="action-bar"
      className="fixed inset-x-0 bottom-0 z-10 border-t-4 border-ink bg-page p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <button type="button" data-testid="open-log-sheet" onClick={onClick} className={`${BTN_PRIMARY} min-h-[64px] w-full text-2xl`}>
        <PlusIcon /> Log allocation
      </button>
    </div>
  );
}
