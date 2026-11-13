import { testPool } from "./deps.js";

/**
 * Waits until `count` sessions wait for session `pid`, directly or behind
 * another session that does, so a test knows its sessions queued on a lock
 * before it lets the lock go.
 */
export async function waitingOn(pid: number, count: number): Promise<void> {
  const waiting = `with recursive waiting(pid) as (
      select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
      union
      select a.pid from pg_stat_activity a
        join waiting w on w.pid = any(pg_blocking_pids(a.pid)))
    select count(*)::int as sessions from waiting`;
  for (let tries = 0; tries < 1000; tries += 1) {
    const { rows } = await testPool("migrator").query<{ sessions: number }>(
      waiting,
      [pid],
    );
    if ((rows[0]?.sessions ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Fewer than ${String(count)} sessions waited for ${String(pid)} within 10 s`,
  );
}
