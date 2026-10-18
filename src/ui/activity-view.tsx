import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityCall, ActivitySnapshot, ActivityTask } from '../core/activity-contracts.js';
import type { SessionClient } from './session-client.js';
import { useOutputTail, useSubagentStream } from './use-activity-streams.js';

type ActivityClient = Pick<
  SessionClient,
  'sessionId' | 'subagentActivity' | 'outputTail' | 'outputWindow' | 'translateActivityReport'
>;
type CardStatus = ActivityTask['status'] | 'unknown';
/** Pixels from the bottom that still count as "at the bottom" for the output tail's auto-scroll. */
const STICK_TO_BOTTOM_PX = 8;

function clock(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function duration(from?: string, to?: string | number): string {
  if (!from || to === undefined) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** A running task's elapsed time; only this span re-renders every second. */
function Elapsed({ since }: { since?: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const text = duration(since, now);
  return text ? <span>{text}</span> : null;
}

function TimelineRow({ call }: { call: ActivityCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-row" data-call={call.id}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <time>{clock(call.timestamp)}</time>
        <span className="activity-tool">{call.tool}</span>
        <span className="activity-summary">
          {call.summary}
          {call.background && ' · background'}
        </span>
        {call.result?.failed && <span className="activity-failed">· failed</span>}
      </button>
      {open && (
        <div className="activity-detail">
          <pre>{call.input}</pre>
          {call.result && <pre>{call.result.text}</pre>}
        </div>
      )}
    </div>
  );
}
/** Tool calls newest first. */
function Timeline({ calls }: { calls: readonly ActivityCall[] }) {
  return (
    <div className="activity-timeline">
      {[...calls].reverse().map((call) => (
        <TimelineRow key={call.id} call={call} />
      ))}
    </div>
  );
}

function SubagentTimeline({
  client,
  taskId,
  active,
}: {
  client: ActivityClient;
  taskId: string;
  active: boolean;
}) {
  const stream = useSubagentStream(client, taskId, active);
  return (
    <div className="activity-sub">
      {stream.calls.length > 0 ? (
        <Timeline calls={stream.calls} />
      ) : (
        <p className="activity-meta">
          {active ? 'Waiting for its first tool call.' : 'No live transcript.'}
        </p>
      )}
      {stream.gaps.map((gap) => (
        <p key={gap} className="activity-meta">
          {gap}
        </p>
      ))}
    </div>
  );
}

function Report({ task, translationOn }: { task: ActivityTask; translationOn: boolean }) {
  if (!task.report) return null;
  const translation = task.reportTranslation;
  if (translationOn && translation?.status === 'complete')
    return (
      <div className="activity-report" dir="rtl">
        {translation.text}
      </div>
    );
  return (
    <>
      <div className="activity-report" dir="ltr">
        {task.report}
      </div>
      {translationOn && translation?.status === 'pending' && (
        <p className="activity-meta">Translating the report…</p>
      )}
    </>
  );
}

function OutputPanel({ client, taskId }: { client: ActivityClient; taskId: string }) {
  const tail = useOutputTail(client, taskId, true);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = pre.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [tail.lines]);
  return (
    <div className="activity-output">
      {tail.start > 0 && (
        <button type="button" className="activity-button" onClick={() => void tail.showEarlier()}>
          Show earlier
        </button>
      )}
      <pre
        ref={pre}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_PX;
        }}
      >
        {tail.lines}
      </pre>
      {tail.error && (
        <p className="activity-meta" role="status">
          {tail.error}
        </p>
      )}
    </div>
  );
}

function TaskCard({
  client,
  task,
  disconnected,
  translationOn,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
  translationOn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status: CardStatus = disconnected && task.status === 'running' ? 'unknown' : task.status;
  const subagent = task.kind === 'subagent';
  const timing =
    status === 'unknown' ? (
      <span>Session disconnected</span>
    ) : status === 'running' ? (
      <Elapsed since={task.startedAt} />
    ) : (
      <span>
        {[`${status} ${clock(task.finishedAt)}`.trim(), duration(task.startedAt, task.finishedAt)]
          .filter(Boolean)
          .join(' · ')}
      </span>
    );
  const title = (
    <>
      <b>
        <span aria-hidden="true">{status === 'running' ? '● ' : '○ '}</span>
        {subagent ? 'Subagent' : 'Background'} · {task.description}
      </b>
      {task.depth > 1 && <span className="activity-nested">nested ×{task.depth}</span>}
    </>
  );
  const labels = subagent ? [task.agentType, task.model].filter(Boolean).join(' · ') : '';
  const meta = (
    <span className="activity-meta">
      {labels && `${labels} · `}
      {timing}
    </span>
  );
  return (
    <article className="activity-card" data-task={task.id} data-status={status}>
      {subagent ? (
        <button
          type="button"
          className="activity-card-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="activity-title">{title}</span>
          {meta}
        </button>
      ) : (
        <div className="activity-card-head">
          <span className="activity-title">{title}</span>
          <span className="activity-head-end">
            {meta}
            {task.outputAvailable && !disconnected && (
              <button
                type="button"
                className="activity-button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                {open ? 'Hide output' : 'Show output'}
              </button>
            )}
          </span>
        </div>
      )}
      {!subagent && task.command && (
        <div className="activity-meta">
          <code>{task.command}</code>
        </div>
      )}
      {subagent && open && (
        <SubagentTimeline client={client} taskId={task.id} active={!disconnected} />
      )}
      {!subagent && open && !disconnected && <OutputPanel client={client} taskId={task.id} />}
      {subagent && <Report task={task} translationOn={translationOn} />}
    </article>
  );
}

/** Running work first, then finished; each group newest first. */
function cardOrder(tasks: readonly ActivityTask[]): ActivityTask[] {
  const newest = [...tasks].reverse();
  return [
    ...newest.filter((task) => task.status === 'running'),
    ...newest.filter((task) => task.status !== 'running'),
  ];
}

/** Asks once per task for a translation of each finished subagent report that has none yet. */
function useReportTranslations(
  client: ActivityClient,
  tasks: readonly ActivityTask[],
  translationOn: boolean,
) {
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!translationOn) return;
    for (const task of tasks) {
      if (task.kind !== 'subagent' || !task.report || task.reportTranslation) continue;
      const key = `${client.sessionId}:${task.id}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      // The server answers only after translating; its pending and complete states arrive in the snapshot
      // stream, so the response is not awaited here. A failed request leaves the English report in place.
      void client.translateActivityReport(task.id).catch(() => {});
    }
  }, [client, tasks, translationOn]);
}

export function ActivityView({
  client,
  activity,
  translationOn,
  agentIsClaude,
  disconnected,
}: {
  client: ActivityClient;
  activity: ActivitySnapshot | undefined;
  translationOn: boolean;
  agentIsClaude: boolean;
  disconnected: boolean;
}) {
  const tasks = activity?.tasks ?? [];
  const calls = activity?.calls ?? [];
  useReportTranslations(client, tasks, translationOn);
  if (tasks.length === 0 && calls.length === 0)
    return (
      <div className="activity" dir="ltr">
        <p className="activity-empty">No tool calls yet.</p>
      </div>
    );
  return (
    <div className="activity" dir="ltr">
      {tasks.length > 0 && (
        <section className="activity-tasks" aria-label="Running now">
          <h3 className="activity-label">Running now</h3>
          {cardOrder(tasks).map((task) => (
            <TaskCard
              key={task.id}
              client={client}
              task={task}
              disconnected={disconnected}
              translationOn={translationOn}
            />
          ))}
        </section>
      )}
      <section className="activity-main" aria-label="Tool timeline">
        <h3 className="activity-label">
          {agentIsClaude ? 'What Claude did' : 'What the agent did'}
        </h3>
        {calls.length > 0 ? (
          <Timeline calls={calls} />
        ) : (
          <p className="activity-empty">No tool calls yet.</p>
        )}
      </section>
    </div>
  );
}
