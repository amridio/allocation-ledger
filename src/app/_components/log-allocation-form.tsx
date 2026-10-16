"use client";

import { useState } from "react";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, HEADING, INPUT, LABEL } from "@/ui/styles";
import { PlusIcon } from "./icons";

/** Whole numbers of 1 or more. The server is the authority; this only stops obvious typos. */
function parseUnits(text: string): number | null {
  if (!/^[0-9]{1,7}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/** Big numeric input, glove-sized quick-add buttons, one primary button. Used in the desktop column and in the mobile sheet. */
export function LogAllocationForm({
  onSubmit,
  idPrefix,
  autoFocus = false,
  framed = false,
}: {
  onSubmit: (units: number) => void;
  idPrefix: string;
  autoFocus?: boolean;
  /** Wrap in a card with a heading (the desktop column); the mobile sheet supplies its own. */
  framed?: boolean;
}) {
  const [text, setText] = useState("");
  const [showError, setShowError] = useState(false);
  // Right after a send the field is empty on purpose: a second tap of a double tap is not a typo.
  const [justSent, setJustSent] = useState(false);
  const units = parseUnits(text);
  const inputId = `${idPrefix}-units`;

  const form = (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (units === null) {
          if (!justSent) setShowError(true);
          return;
        }
        onSubmit(units);
        setText("");
        setShowError(false);
        setJustSent(true);
      }}
    >
      <label htmlFor={inputId} className={LABEL}>
        Units to log
      </label>
      <input
        id={inputId}
        data-testid="units-input"
        name="units"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => {
          setText(e.target.value.replace(/\D/g, "").slice(0, 7));
          setShowError(false);
          setJustSent(false);
        }}
        aria-invalid={showError && units === null}
        aria-describedby={showError && units === null ? `${inputId}-error` : undefined}
        className={INPUT}
      />
      {showError && units === null && (
        <p id={`${inputId}-error`} role="alert" className="mt-2 text-lg font-bold text-danger">
          Enter a whole number of 1 or more.
        </p>
      )}

      <div className="mt-3 grid grid-cols-[1fr_1fr_1fr_1.8fr] gap-3" role="group" aria-label="Quick add">
        {[1, 5, 10].map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`quick-add-${n}`}
            onClick={() => {
              setText(String((units ?? 0) + n));
              setShowError(false);
              setJustSent(false);
            }}
            className={`${BTN_SECONDARY} !px-0`}
          >
            +{n}
          </button>
        ))}
        <button type="button" data-testid="quick-clear" onClick={() => {
            setText("");
            setJustSent(false);
          }} className={`${BTN_SECONDARY} !px-0`}>
          Clear
        </button>
      </div>

      <p className="mt-4 text-lg font-bold" aria-live="polite" data-testid="form-summary">
        {units === null ? "Enter how many units you are logging." : `You are logging ${units} unit${units === 1 ? "" : "s"}.`}
      </p>
      <button type="submit" data-testid="submit-allocation" className={`${BTN_PRIMARY} mt-3 min-h-[64px] w-full text-2xl`}>
        <PlusIcon /> Log allocation
      </button>
    </form>
  );

  if (!framed) return form;
  return (
    <section aria-labelledby={`${idPrefix}-heading`} className={CARD}>
      <h2 id={`${idPrefix}-heading`} className={`${HEADING} mb-4`}>
        Log allocation
      </h2>
      {form}
    </section>
  );
}
