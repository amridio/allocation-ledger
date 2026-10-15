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

export interface OutboxState {
  /** Newest first. */
  items: OutboxItem[];
}

export type OutboxAction =
  | { type: "add"; key: string; units: number }
  | { type: "sent"; key: string }
  | { type: "failed"; key: string; error: OutboxError }
  | { type: "retry"; key: string }
  | { type: "dismiss"; key: string };

export const initialOutbox: OutboxState = { items: [] };

const update = (state: OutboxState, key: string, fn: (item: OutboxItem) => OutboxItem): OutboxState => {
  if (!state.items.some((i) => i.key === key)) return state;
  return { items: state.items.map((i) => (i.key === key ? fn(i) : i)) };
};

export function outboxReducer(state: OutboxState, action: OutboxAction): OutboxState {
  switch (action.type) {
    case "add":
      if (state.items.some((i) => i.key === action.key)) return state;
      return { items: [{ key: action.key, units: action.units, status: "sending", attempts: 1 }, ...state.items] };
    case "sent":
      return { items: state.items.filter((i) => i.key !== action.key) };
    case "failed":
      return update(state, action.key, (i) => ({ ...i, status: "failed", error: action.error }));
    case "retry":
      return update(state, action.key, (i) => {
        if (i.status !== "failed") return i;
        const { error: _error, ...rest } = i; // eslint-disable-line @typescript-eslint/no-unused-vars
        return { ...rest, status: "sending", attempts: i.attempts + 1 };
      });
    case "dismiss":
      return { items: state.items.filter((i) => !(i.key === action.key && i.status === "failed")) };
  }
}

/** Units that are still being sent (failed ones are not counted: they may never arrive). */
export function pendingUnits(state: OutboxState): number[] {
  return state.items.filter((i) => i.status === "sending").map((i) => i.units);
}
