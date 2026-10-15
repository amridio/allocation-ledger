import Link from "next/link";
import { UserIcon } from "./icons";

export function AppHeader({
  name,
  role,
  switcherEnabled,
}: {
  name: string;
  role: "OPERATOR" | "SUPERVISOR";
  switcherEnabled: boolean;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b-4 border-ink pb-4">
      <h1 className="text-2xl font-extrabold">Allocation Ledger</h1>
      <div className="flex flex-wrap items-center gap-3 text-lg font-bold">
        <span data-testid="current-user" className="inline-flex items-center gap-2">
          <UserIcon />
          {name} · {role === "SUPERVISOR" ? "Supervisor" : "Operator"}
        </span>
        {switcherEnabled && (
          <Link
            href="/?switch=1"
            data-testid="switch-user-link"
            className="inline-flex min-h-[56px] items-center rounded-xl border-4 border-ink px-5 text-lg font-bold underline"
          >
            Switch user
          </Link>
        )}
      </div>
    </header>
  );
}
