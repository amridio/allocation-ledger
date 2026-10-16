export interface OutboxError {
  code: string;
  message: string;
}

export interface OutboxItem {
  /** The Idempotency-Key. Created once and never changed, so a retry can't double count. */
  key: string;
  units: number;
  status: "sending" | "failed";
  attempts: number;
  error?: OutboxError;
}

/** What the screen tells the user after the server REJECTED an allocation and it was rolled back. */
export interface OutboxNotice {
  key: string;
  units: number;
  code: string;
  message: string;
}

export interface OutboxState {
  /** Allocations not yet confirmed, newest first. */
  items: OutboxItem[];
  /** Rolled-back allocations the user hasn't dismissed, newest first. */
  notices: OutboxNotice[];
}

export type OutboxAction =
  | { type: "add"; key: string; units: number }
  | { type: "sent"; key: string }
  /** No answer (offline, busy): the entry may still be valid, so it stays as "Not sent" with a Retry (same key). */
  | { type: "failed"; key: string; error: OutboxError }
  | { type: "retry"; key: string }
  | { type: "dismiss"; key: string }
  /** The server REJECTED it (pool full, not allowed...). Retrying can't help: remove it and say why. */
  | { type: "rolledBack"; key: string; error: OutboxError }
  | { type: "dismissNotice"; key: string };

export const initialOutbox: OutboxState = { items: [], notices: [] };

const update = (state: OutboxState, key: string, fn: (item: OutboxItem) => OutboxItem): OutboxState => {
  if (!state.items.some((i) => i.key === key)) return state;
  return { ...state, items: state.items.map((i) => (i.key === key ? fn(i) : i)) };
};

export function outboxReducer(state: OutboxState, action: OutboxAction): OutboxState {
  switch (action.type) {
    case "add":
      if (state.items.some((i) => i.key === action.key)) return state;
      return {
        ...state,
        items: [{ key: action.key, units: action.units, status: "sending", attempts: 1 }, ...state.items],
      };
    case "sent":
      return { ...state, items: state.items.filter((i) => i.key !== action.key) };
    case "failed":
      return update(state, action.key, (i) => ({ ...i, status: "failed", error: action.error }));
    case "retry":
      return update(state, action.key, (i) => {
        if (i.status !== "failed") return i;
        const { error: _error, ...rest } = i; // eslint-disable-line @typescript-eslint/no-unused-vars
        return { ...rest, status: "sending", attempts: i.attempts + 1 };
      });
    case "dismiss":
      return { ...state, items: state.items.filter((i) => !(i.key === action.key && i.status === "failed")) };
    case "rolledBack": {
      const item = state.items.find((i) => i.key === action.key);
      if (!item) return state;
      return {
        items: state.items.filter((i) => i.key !== action.key),
        notices: [{ key: item.key, units: item.units, code: action.error.code, message: action.error.message }, ...state.notices],
      };
    }
    case "dismissNotice":
      return { ...state, notices: state.notices.filter((n) => n.key !== action.key) };
  }
}

/** Units that are still being synced (failed ones are not counted: they may never arrive). */
export function pendingUnits(state: OutboxState): number[] {
  return state.items.filter((i) => i.status === "sending").map((i) => i.units);
}
