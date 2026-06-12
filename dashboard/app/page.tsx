import { getFocus, getMatrix, getVelocity, domainColor, type MatrixTask, type Quadrant } from "@/lib/data";

export const revalidate = 30;
export const dynamic = "force-dynamic";

const QUADRANTS: Array<{ key: Quadrant; label: string; sub: string; accent: string }> = [
  { key: "do",       label: "DO NOW",   sub: "דחוף + חשוב",   accent: "#ff5247" },
  { key: "schedule", label: "SCHEDULE", sub: "חשוב",          accent: "#d4ff3f" },
  { key: "delegate", label: "DELEGATE", sub: "דחוף",          accent: "#ffb74a" },
  { key: "later",    label: "LATER",    sub: "לא דחוף",       accent: "#555555" },
];

function stripEmoji(title: string): string {
  return title.replace(/^[🔴🟡🟠⚪]\s*/u, "");
}

export default async function MissionControl() {
  let focus = null, matrix = { tasks: [] as MatrixTask[], snappedAt: null as string | null };
  let velocity = { days: [] as Awaited<ReturnType<typeof getVelocity>>["days"], thisWeek: 0, lastWeek: 0 };
  let dbError: string | null = null;

  try {
    [focus, matrix, velocity] = await Promise.all([getFocus(), getMatrix(), getVelocity(14)]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const delta = velocity.lastWeek > 0
    ? Math.round(((velocity.thisWeek - velocity.lastWeek) / velocity.lastWeek) * 100)
    : null;
  const maxDay = Math.max(1, ...velocity.days.map((d) => d.total));
  const doneCount = focus?.items.filter((i) => i.done).length ?? 0;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      {/* Header */}
      <header className="flex items-baseline justify-between border-b border-hairline pb-4">
        <h1 className="text-xl tracking-[0.3em] text-white">MISSION CONTROL</h1>
        <span className="text-xs text-dim" dir="ltr">
          {matrix.snappedAt ? `SNAP ${matrix.snappedAt.slice(11, 16)}Z` : "NO SNAPSHOT"}
        </span>
      </header>

      {dbError && (
        <div className="mt-6 border border-red-900 bg-panel p-4 text-sm text-red-400" dir="ltr">
          DB: {dbError}
        </div>
      )}

      {/* Focus strip */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xs tracking-[0.25em] text-dim">ACTIVE FOCUS — {focus ? `${doneCount}/${focus.items.length}` : "NOT SET"}</h2>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-px bg-hairline border border-hairline md:grid-cols-3">
          {(focus?.items ?? [{ text: "לא הוגדר פוקוס להיום", done: false }]).map((item, i) => (
            <div key={i} className="bg-panel p-4 flex items-center gap-3">
              <span
                className="inline-block h-2 w-2 shrink-0"
                style={{ background: item.done ? "#d4ff3f" : "#333333" }}
              />
              <span className={item.done ? "text-dim line-through" : "text-white"}>{item.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Eisenhower matrix */}
      <section className="mt-10">
        <h2 className="text-xs tracking-[0.25em] text-dim">EISENHOWER MATRIX — {matrix.tasks.length} OPEN</h2>
        <div className="mt-3 grid grid-cols-1 gap-px bg-hairline border border-hairline md:grid-cols-2">
          {QUADRANTS.map((q) => {
            const tasks = matrix.tasks.filter((t) => t.quadrant === q.key);
            return (
              <div key={q.key} className="bg-panel p-4 min-h-44">
                <div className="flex items-baseline justify-between border-b border-hairline pb-2">
                  <span className="text-sm tracking-[0.2em]" style={{ color: q.accent }}>{q.label}</span>
                  <span className="text-xs text-dim">{q.sub} · {tasks.length}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {tasks.slice(0, 8).map((t, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="inline-block h-1.5 w-1.5 shrink-0" style={{ background: domainColor(t.listTitle) }} />
                      <span className={t.overdue ? "text-red-400" : "text-neutral-300"}>{stripEmoji(t.title)}</span>
                      {t.overdue && <span className="text-[10px] text-red-500 tracking-widest">OVERDUE</span>}
                    </li>
                  ))}
                  {tasks.length === 0 && <li className="text-xs text-dim">—</li>}
                  {tasks.length > 8 && <li className="text-xs text-dim">+{tasks.length - 8} נוספות</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* Velocity */}
      <section className="mt-10 pb-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs tracking-[0.25em] text-dim">VELOCITY — 14D</h2>
          <span className="text-xs" dir="ltr">
            <span className="text-white">{velocity.thisWeek}</span>
            <span className="text-dim"> THIS WK / {velocity.lastWeek} LAST</span>
            {delta !== null && (
              <span style={{ color: delta >= 0 ? "#d4ff3f" : "#ff5247" }}> {delta >= 0 ? "+" : ""}{delta}%</span>
            )}
          </span>
        </div>
        <div className="mt-3 border border-hairline bg-panel p-4">
          <div className="flex h-40 items-end gap-1" dir="ltr">
            {velocity.days.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col justify-end gap-px" title={`${d.date}: ${d.total}`}>
                {Object.entries(d.byDomain).map(([domain, n]) => (
                  <div
                    key={domain}
                    style={{ height: `${(n / maxDay) * 100}%`, background: domainColor(domain), minHeight: n > 0 ? 3 : 0 }}
                  />
                ))}
                {d.total === 0 && <div style={{ height: 2, background: "#1a1a1a" }} />}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-dim" dir="ltr">
            <span>{velocity.days[0]?.date.slice(5)}</span>
            <span>{velocity.days[velocity.days.length - 1]?.date.slice(5)}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
