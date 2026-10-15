import { cookies } from "next/headers";
import { resolveTimeZone } from "@/ui/time";
import { findSessionUser, SESSION_COOKIE } from "@/server/api/auth";
import { isUserSwitcherEnabled } from "@/server/api/default-context";
import { loadDashboard } from "@/server/dashboard";
import { db } from "@/server/db";
import { listAllUsersForSwitcher } from "@/server/queries/operators";
import { Dashboard } from "./_components/dashboard";
import { UserSwitcher } from "./_components/user-switcher";

/*
 * Loaded entirely on the server: this route BLOCKS until its data is ready (instant = false), so
 * the first HTML response already contains the numbers. There is no Suspense fallback and no
 * client-side loading state on first open.
 */
export const instant = false;

const DEFAULT_POLL_MS = 3_000;

export default async function Page({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const switcherEnabled = isUserSwitcherEnabled();
  const user = await findSessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);

  // Not signed in (or asked to switch): the temporary user switcher, if it is enabled.
  if (!user || (switcherEnabled && params["switch"] === "1")) {
    return (
      <main className="mx-auto w-full max-w-xl p-4 lg:p-8">
        <h1 className="mb-4 border-b-4 border-ink pb-4 text-2xl font-extrabold">Allocation Ledger</h1>
        {switcherEnabled ? (
          <UserSwitcher users={await listAllUsersForSwitcher(db)} currentId={user?.id ?? null} />
        ) : (
          <p className="text-xl font-bold" data-testid="signed-out">
            You are not signed in. Sign-in isn&apos;t available yet.
          </p>
        )}
      </main>
    );
  }

  const requested = typeof params["operator"] === "string" ? params["operator"] : undefined;
  const data = await loadDashboard(db, user, requested, new Date());
  const pollMs = Number(process.env["UI_POLL_MS"]);
  return (
    <main>
      <Dashboard
        data={data}
        config={{
          pollMs: Number.isFinite(pollMs) && pollMs >= 500 ? pollMs : DEFAULT_POLL_MS,
          timeZone: resolveTimeZone(process.env["APP_TIMEZONE"]),
          switcherEnabled,
        }}
      />
    </main>
  );
}
