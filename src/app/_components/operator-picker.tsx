"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { PoolOperatorDto } from "@/domain/wire";
import { CARD, INPUT, LABEL } from "@/ui/styles";

/** Supervisors choose whose metric and status history to look at. Changing it reloads from the server, so there is no empty state. */
export function OperatorPicker({ operators, selectedId }: { operators: PoolOperatorDto[]; selectedId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className={CARD}>
      <label htmlFor="operator-picker" className={LABEL}>
        Operator
      </label>
      <select
        id="operator-picker"
        data-testid="operator-picker"
        value={selectedId}
        aria-busy={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => router.replace(`/?operator=${encodeURIComponent(id)}`));
        }}
        className={INPUT}
      >
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.role === "SUPERVISOR" ? " (supervisor)" : ""}
          </option>
        ))}
      </select>
      <p className="mt-2 text-lg" aria-live="polite">
        {pending ? "Switching operator…" : "Shows this operator's status and history."}
      </p>
    </div>
  );
}
