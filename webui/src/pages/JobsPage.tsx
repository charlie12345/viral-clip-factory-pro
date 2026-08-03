import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, X, RotateCcw, ChevronRight, AlertCircle, CheckCircle2, Clock, FileVideo, FilePlus2, RefreshCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type JobHistoryEntry } from '@/api/client';
import { useActiveJob, useJobs, useLogs } from '@/hooks/queries';

export function JobsPage() {
  const qc = useQueryClient();
  const { data: active } = useActiveJob();
  const { data: jobs = [], isLoading } = useJobs();
  const { data: logs = [] } = useLogs(120);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(),
    onSuccess: () => {
      setConfirmCancel(false);
      qc.invalidateQueries({ queryKey: ['job-status'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-white">Jobs</h1>
          <p className="mt-1 text-sm text-slate-400">Active and past render jobs.</p>
        </div>
      </header>

      {/* Active job card */}
      <section className="panel-elev p-4 sm:p-5">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className={clsx(
              'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
              active?.active
                ? 'bg-gradient-to-br from-violet-500 to-pink-500 shadow-glow-pink'
                : active?.error
                  ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30'
                  : 'bg-white/5 text-slate-300',
            )}>
              {active?.active ? <Activity className="h-5 w-5 animate-pulse-soft text-white" /> :
               active?.error ? <AlertCircle className="h-5 w-5" /> :
               <CheckCircle2 className="h-5 w-5 text-emerald-400" />}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">
                {active?.active ? 'Job running' : active?.error ? 'Last job errored' : 'Idle'}
              </div>
              <div className="min-w-0 break-all text-[11px] leading-relaxed text-slate-400">
                {active?.label || 'No active job'} {active?.pid && <span className="whitespace-nowrap font-mono text-slate-500">· PID {active.pid}</span>}
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {active?.startedAt && <span className="chip"><Clock className="h-3 w-3" /> Started {formatTime(active.startedAt)}</span>}
            {active?.finishedAt && <span className="chip">Finished {formatTime(active.finishedAt)}</span>}
            {active?.active && <span className="chip font-mono">{active.computeDevice || 'auto'} · {active.videoEncoder || 'auto'}</span>}
            {active?.active && (
              <>
                {!confirmCancel ? (
                  <button className="btn-danger" onClick={() => setConfirmCancel(true)}>
                    <X className="h-4 w-4" /> Cancel
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">Are you sure?</span>
                    <button className="btn-secondary" onClick={() => setConfirmCancel(false)}>No</button>
                    <button
                      className="btn-danger"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      {cancel.isPending ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      Yes, cancel
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {active?.error && (
          <div className="mt-3 break-words rounded-md bg-red-500/10 px-3 py-2 text-[12px] text-red-300 ring-1 ring-red-500/30">
            {active.error}
          </div>
        )}

        {/* Live logs */}
        <div className="mt-4 min-w-0 max-w-full overflow-hidden rounded-lg border border-white/5 bg-black/40">
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
            <span>Live output</span>
            <span>{logs.length} lines</span>
          </div>
          <pre className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {logs.length === 0 ? <span className="text-slate-500 italic">No output yet…</span> : logs.join('\n')}
          </pre>
        </div>
      </section>

      {/* Job history */}
      <section>
        <h2 className="section-title mb-3">History</h2>
        {isLoading ? (
          <div className="panel-elev grid place-items-center py-10 text-slate-500">
            <RefreshCcw className="h-5 w-5 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="panel-elev grid place-items-center gap-2 py-10 text-slate-500">
            <FileVideo className="h-6 w-6 opacity-50" />
            <p>No job history yet. Run a render from the Dashboard to see it here.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {jobs.map((job) => <JobHistoryCard key={job.id} job={job} />)}
            </div>
            <div className="panel hidden max-w-full overflow-x-auto md:block">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Kind</th>
                  <th className="px-4 py-2 text-left">Label</th>
                  <th className="px-4 py-2 text-left">Started</th>
                  <th className="px-4 py-2 text-left">Duration</th>
                  <th className="px-4 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => <JobRow key={j.id} job={j} />)}
              </tbody>
            </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function JobRow({ job }: { job: JobHistoryEntry }) {
  const started = new Date(job.startedAt);
  const ended = job.finishedAt ? new Date(job.finishedAt) : null;
  const durationMs = ended ? ended.getTime() - started.getTime() : 0;

  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.02]">
      <td className="px-4 py-2.5">
        <JobStatusBadge status={job.status} />
      </td>
      <td className="px-4 py-2.5 text-xs text-slate-300">
        <span className="inline-flex items-center gap-1.5">
          {job.kind === 'rerender' ? <RotateCcw className="h-3 w-3" /> :
           job.kind === 'url' ? <FilePlus2 className="h-3 w-3" /> :
           <FileVideo className="h-3 w-3" />}
          {job.kind}
        </span>
        <div className="mt-1 font-mono text-[9px] text-slate-600">{job.computeDevice || 'auto'} · {job.videoEncoder || 'auto'}</div>
      </td>
      <td className="px-4 py-2.5 max-w-xs truncate font-mono text-xs text-slate-200" title={job.label}>{job.label}</td>
      <td className="px-4 py-2.5 text-xs text-slate-400">{formatTime(job.startedAt)}</td>
      <td className="px-4 py-2.5 text-xs text-slate-400">{ended ? formatDuration(durationMs) : '—'}</td>
      <td className="px-4 py-2.5 text-right">
        {job.error && <span className="text-[10px] text-red-400" title={job.error}>{job.error.slice(0, 40)}</span>}
        <ChevronRight className="ml-2 inline h-3 w-3 text-slate-600" />
      </td>
    </tr>
  );
}

function JobHistoryCard({ job }: { job: JobHistoryEntry }) {
  const started = new Date(job.startedAt);
  const ended = job.finishedAt ? new Date(job.finishedAt) : null;
  const durationMs = ended ? ended.getTime() - started.getTime() : 0;
  return (
    <article className="panel-elev min-w-0 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <JobStatusBadge status={job.status} />
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-slate-400">
          {job.kind === 'rerender' ? <RotateCcw className="h-3 w-3" /> :
           job.kind === 'url' ? <FilePlus2 className="h-3 w-3" /> :
           <FileVideo className="h-3 w-3" />}
          {job.kind}
        </span>
      </div>
      <div className="mt-3 break-all font-mono text-xs leading-relaxed text-slate-200">{job.label}</div>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/5 pt-3 text-[10px]">
        <div className="min-w-0">
          <div className="uppercase tracking-wider text-slate-600">Started</div>
          <div className="mt-1 break-words text-slate-400">{formatTime(job.startedAt)}</div>
        </div>
        <div className="min-w-0">
          <div className="uppercase tracking-wider text-slate-600">Duration</div>
          <div className="mt-1 text-slate-400">{ended ? formatDuration(durationMs) : 'In progress'}</div>
        </div>
      </div>
      {job.error && <div className="mt-3 break-words rounded-lg bg-red-500/10 px-3 py-2 text-[10px] leading-relaxed text-red-300">{job.error}</div>}
      <div className="mt-3 font-mono text-[9px] text-slate-600">{job.computeDevice || 'auto'} · {job.videoEncoder || 'auto'}</div>
    </article>
  );
}

function JobStatusBadge({ status }: { status: JobHistoryEntry['status'] }) {
  return (
    <span className={clsx(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
      status === 'running' ? 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30' :
      status === 'complete' ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30' :
      status === 'cancelled' ? 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30' :
      status === 'interrupted' ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30' :
      'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
    )}>
      {status === 'running' ? <Activity className="h-2.5 w-2.5 animate-pulse-soft" /> :
       status === 'complete' ? <CheckCircle2 className="h-2.5 w-2.5" /> :
       status === 'cancelled' ? <X className="h-2.5 w-2.5" /> :
       status === 'interrupted' ? <Clock className="h-2.5 w-2.5" /> :
       <AlertCircle className="h-2.5 w-2.5" />}
      {status}
    </span>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
