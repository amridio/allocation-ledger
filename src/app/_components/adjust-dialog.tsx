"use client";

import { useEffect, useRef, useState } from "react";
import type { EntryDto } from "@/domain/wire";
import { ApiClientError } from "@/ui/api-client";
import { formatSigned } from "@/ui/format";
import { newIdempotencyKey } from "@/ui/idempotency";
import { BTN_PRIMARY, BTN_SECONDARY, HEADING, INPUT, LABEL } from "@/ui/styles";
import { formatWhen } from "@/ui/time";
import { CloseIcon, MinusIcon, PlusIcon } from "./icons";
import { InlineAlert } from "./inline-alert";

export interface AdjustBody {
  targetSeq: number;
  units: number;
  reason: string;
}

function messageFor(error: ApiClientError): string {
  switch (error.code) {
    case "ADJUSTMENT_BELOW_ZERO":
      return "That would take this entry below zero units once all its adjustments are counted. Use a smaller amount.";
    case "CAPACITY_EXCEEDED":
      return "The pool doesn't have room for those extra units.";
    case "TARGET_OTHER_POOL":
    case "FORBIDDEN":
      return "You can only adjust entries in your own pool.";
    case "NETWORK":
    case "BUSY":
      return `${error.message} Nothing was saved twice: it is safe to try again.`;
    default:
      return error.message;
  }
}

function parseAmount(text: string): number | null {
  if (!/^[0-9]{1,7}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/**
 * Supervisor action: change an earlier allocation by a number of units, with a required reason.
 * "Remove" / "Add" buttons instead of typing a minus sign (a numeric keypad often has no minus).
 *
 * Retrying after a failure re-sends the SAME Idempotency-Key, so it can't be applied twice. If the
 * supervisor changes anything first, it is a different request and gets a new key.
 */
export function AdjustDialog({
  target,
  operatorName,
  now,
  timeZone,
  onClose,
  onSubmit,
}: {
  target: EntryDto;
  operatorName: string;
  now: Date;
  timeZone: string;
  onClose: () => void;
  /** Throws an ApiClientError on failure. */
  onSubmit: (body: AdjustBody, idempotencyKey: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [direction, setDirection] = useState<"remove" | "add">("remove");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const units = parseAmount(amount);
  const trimmedReason = reason.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return; // a double tap while saving: the first request is still the one that counts
    if (units === null || trimmedReason === "") {
      setShowErrors(true);
      return;
    }
    const body: AdjustBody = { targetSeq: target.seq, units: direction === "remove" ? -units : units, reason: trimmedReason };
    const fingerprint = JSON.stringify(body);
    if (keyRef.current?.fingerprint !== fingerprint) keyRef.current = { fingerprint, key: newIdempotencyKey() };

    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(body, keyRef.current.key);
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err : new ApiClientError(0, "NETWORK", "Couldn't save.", true));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const segment = (active: boolean) =>
    `${BTN_SECONDARY} min-w-0 flex-1 !gap-2 !px-3 ${active ? "!bg-action !text-action-text" : ""}`;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="adjust-title"
      data-testid="adjust-dialog"
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[94dvh] w-full max-w-none overflow-auto rounded-t-3xl border-4 border-ink bg-page p-0 text-ink backdrop:bg-black/70 lg:inset-auto lg:left-1/2 lg:top-1/2 lg:w-[34rem] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-3xl"
    >
      <div className="mb-3 flex items-center justify-between gap-3 px-5 pt-5">
        <h2 id="adjust-title" className={HEADING}>
          Adjust entry #{target.seq}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className={`${BTN_SECONDARY} !px-4`}>
          <CloseIcon />
        </button>
      </div>
      <p className="mb-4 px-5 text-lg font-bold" data-testid="adjust-summary">
        {operatorName} · {formatSigned(target.units)} units · {formatWhen(target.effectiveAt, now, timeZone)}
      </p>

      <form noValidate onSubmit={submit}>
        <div className="px-5">
          <fieldset className="mb-4 min-w-0">
            <legend className={LABEL}>What do you want to do?</legend>
            <div className="flex gap-3">
              <button type="button" data-testid="adjust-remove" aria-pressed={direction === "remove"} onClick={() => setDirection("remove")} className={segment(direction === "remove")}>
                <MinusIcon /> Remove units
              </button>
              <button type="button" data-testid="adjust-add" aria-pressed={direction === "add"} onClick={() => setDirection("add")} className={segment(direction === "add")}>
                <PlusIcon /> Add units
              </button>
            </div>
          </fieldset>

          <label htmlFor="adjust-amount" className={LABEL}>
            Number of units
          </label>
          <input
            id="adjust-amount"
            data-testid="adjust-amount"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/\D/g, "").slice(0, 7));
              setError(null);
            }}
            aria-invalid={showErrors && units === null}
            className={INPUT}
          />
          {showErrors && units === null && (
            <p role="alert" className="mt-2 text-lg font-bold text-danger">
              Enter a whole number of 1 or more.
            </p>
          )}

          <label htmlFor="adjust-reason" className={`${LABEL} mt-4`}>
            Reason (required)
          </label>
          <textarea
            id="adjust-reason"
            data-testid="adjust-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            aria-invalid={showErrors && trimmedReason === ""}
            className="min-h-[120px] w-full rounded-xl border-4 border-ink bg-page p-4 text-xl text-ink"
          />
          {showErrors && trimmedReason === "" && (
            <p role="alert" className="mt-2 text-lg font-bold text-danger">
              Say why you are changing this entry.
            </p>
          )}

          {error && (
            <div className="mt-4">
              <InlineAlert testId="adjust-error">{messageFor(error)}</InlineAlert>
            </div>
          )}

        </div>
        {/* Pinned to the bottom of the sheet: on a short phone the form scrolls, the buttons never leave thumb reach. */}
        <div className="sticky bottom-0 mt-5 grid grid-cols-2 gap-3 border-t-4 border-border bg-page p-5">
          <button type="button" data-testid="adjust-cancel" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" data-testid="adjust-save" disabled={saving} className={BTN_PRIMARY}>
            {saving ? "Saving…" : error?.retryable ? "Try again" : "Save adjustment"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
