"use client";

import { useEffect, useRef } from "react";
import { BTN_SECONDARY, HEADING } from "@/ui/styles";
import { CloseIcon } from "./icons";
import { LogAllocationForm } from "./log-allocation-form";

/** Mobile: the form in a bottom sheet (a native <dialog>, so focus is trapped and Esc closes it). */
export function LogAllocationSheet({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (units: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="sheet-title"
      data-testid="log-sheet"
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[92dvh] w-full max-w-none overflow-auto rounded-t-3xl border-4 border-ink bg-page p-5 text-ink backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="sheet-title" className={HEADING}>
          Log allocation
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-testid="sheet-close" className={`${BTN_SECONDARY} !px-4`}>
          <CloseIcon />
        </button>
      </div>
      {open && (
        <LogAllocationForm
          idPrefix="sheet"
          autoFocus
          onSubmit={(units) => {
            onSubmit(units);
            onClose();
          }}
        />
      )}
    </dialog>
  );
}
