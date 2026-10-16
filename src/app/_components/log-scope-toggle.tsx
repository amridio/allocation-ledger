"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { dashboardHref } from "@/ui/entries-scope";
import { firstName } from "@/ui/format";

/** Supervisors: the log shows the selected operator by default; "Everyone" widens it to the pool. Reloads from the server, so no empty state. */
export function LogScopeToggle({ operatorId, operatorName, logAll }: { operatorId: string; operatorName: string; logAll: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const choose = (all: boolean) => {
    if (all === logAll) return;
    startTransition(() => router.replace(dashboardHref({ operatorId, logAll: all })));
  };
  const base =
    "min-h-[56px] min-w-0 flex-1 truncate rounded-xl border-4 border-ink px-3 text-xl font-bold";
  return (
    <div role="group" aria-label="Which entries to show" aria-busy={pending} data-testid="log-scope" className="mb-3 flex gap-3">
      <button
        type="button"
        data-testid="log-scope-operator"
        aria-label={`${operatorName}'s entries`}
        aria-pressed={!logAll}
        onClick={() => choose(false)}
        className={`${base} ${logAll ? "bg-page text-ink" : "bg-action text-action-text"}`}
      >
        {!logAll && "✓ "}
        {firstName(operatorName)}
      </button>
      <button
        type="button"
        data-testid="log-scope-all"
        aria-pressed={logAll}
        onClick={() => choose(true)}
        className={`${base} ${logAll ? "bg-action text-action-text" : "bg-page text-ink"}`}
      >
        {logAll && "✓ "}Everyone
      </button>
    </div>
  );
}
