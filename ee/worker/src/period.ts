import type { BudgetPeriod } from "@tokentrail/shared";

export interface PeriodWindow {
  start: Date;
  end: Date;
}

/**
 * Current budget period window in UTC. Per-budget timezone support (SRS
 * FR-BUD-4) follows once the notification channel work lands — the seam is
 * this function's signature.
 */
export function periodWindow(period: BudgetPeriod, now: Date = new Date()): PeriodWindow {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);

  switch (period) {
    case "DAILY":
      end.setUTCDate(end.getUTCDate() + 1);
      break;
    case "WEEKLY": {
      // ISO week: Monday 00:00 UTC
      const day = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - day);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    }
    case "MONTHLY":
      start.setUTCDate(1);
      end.setTime(start.getTime());
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
    case "QUARTERLY": {
      const quarterStartMonth = Math.floor(start.getUTCMonth() / 3) * 3;
      start.setUTCMonth(quarterStartMonth, 1);
      end.setTime(start.getTime());
      end.setUTCMonth(end.getUTCMonth() + 3);
      break;
    }
  }
  return { start, end };
}
