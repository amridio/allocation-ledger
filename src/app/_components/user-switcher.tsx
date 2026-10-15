"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiClientError, createApiClient } from "@/ui/api-client";
import { BTN_SECONDARY, CARD, HEADING } from "@/ui/styles";
import { InlineAlert } from "./inline-alert";
import { UserIcon } from "./icons";

export interface SwitcherUser {
  id: string;
  name: string;
  role: "OPERATOR" | "SUPERVISOR";
  poolName: string;
}

/** TEMPORARY login: pick any user. Only rendered when ENABLE_USER_SWITCHER=true. */
export function UserSwitcher({ users, currentId }: { users: SwitcherUser[]; currentId: string | null }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await createApiClient().switchUser(id);
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't switch user.");
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="switch-heading" className={CARD} data-testid="user-switcher">
      <h2 id="switch-heading" className={HEADING}>
        Choose who you are
      </h2>
      <p className="mb-4 text-lg font-bold">Temporary sign-in for testing. Anyone can pick anyone.</p>
      {error && (
        <div className="mb-4">
          <InlineAlert>{error}</InlineAlert>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {users.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              data-testid="switch-user-option"
              data-user-id={u.id}
              disabled={busyId !== null}
              onClick={() => void pick(u.id)}
              aria-current={u.id === currentId ? "true" : undefined}
              className={`${BTN_SECONDARY} w-full !justify-start text-left ${u.id === currentId ? "!bg-pending-bg" : ""}`}
            >
              <UserIcon />
              <span className="flex flex-col">
                <span>
                  {u.name} {u.id === currentId ? "(you)" : ""}
                </span>
                <span className="text-base font-semibold text-ink-soft">
                  {u.role === "SUPERVISOR" ? "Supervisor" : "Operator"} · {u.poolName}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
