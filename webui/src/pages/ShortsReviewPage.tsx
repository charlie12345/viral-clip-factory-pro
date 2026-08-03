import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Layers3,
  ListChecks,
  Loader2,
  Play,
  Save,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
} from 'lucide-react';
import {
  api,
  type ShortsCandidate,
  type ShortsCandidateFeedback,
} from '@/api/client';

type FeedbackMap = Record<string, ShortsCandidateFeedback>;

function formatTime(seconds: number) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function candidateId(candidate: ShortsCandidate) {
  return candidate.yieldId || candidate.id;
}

export function ShortsReviewPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewEndRef = useRef<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<FeedbackMap>({});
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [hydratedProject, setHydratedProject] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ['shorts-projects'],
    queryFn: () => api.listShortsProjects(),
    refetchInterval: 5_000,
  });
  const preferredProject = projectId || projectsQuery.data?.find((item) => item.status === 'awaiting_review')?.id || projectsQuery.data?.[0]?.id;
  const projectQuery = useQuery({
    queryKey: ['shorts-project', preferredProject],
    queryFn: () => api.getShortsProject(preferredProject || ''),
    enabled: Boolean(preferredProject),
  });

  useEffect(() => {
    const project = projectQuery.data;
    if (!project || hydratedProject === project.id) return;
    const initialSelected = project.candidates
      .filter((candidate) => (
        candidate.selected || candidate.feedback?.decision === 'approved'
      ) && candidate.feedback?.decision !== 'rejected' && !candidate.exported && !candidate.failed)
      .map(candidateId);
    const fallbackTarget = Math.max(1, Number(project.yield.target) || 8);
    const fallbackSelected = project.candidates
      .filter((candidate) => candidate.variantRank === 1
        && candidate.feedback?.decision !== 'rejected'
        && !candidate.exported
        && !candidate.failed)
      .sort((left, right) => right.score - left.score)
      .slice(0, fallbackTarget)
      .map(candidateId);
    setSelected(new Set(initialSelected.length ? initialSelected : fallbackSelected));
    setFeedback(Object.fromEntries(
      project.candidates
        .filter((candidate) => candidate.feedback)
        .map((candidate) => [candidateId(candidate), candidate.feedback as ShortsCandidateFeedback]),
    ));
    setActiveCandidateId(initialSelected[0] || fallbackSelected[0] || project.candidates[0]?.yieldId || null);
    setHydratedProject(project.id);
  }, [projectQuery.data, hydratedProject]);

  const groups = useMemo(() => {
    const map = new Map<string, ShortsCandidate[]>();
    for (const candidate of projectQuery.data?.candidates || []) {
      const key = candidate.clusterId || candidateId(candidate);
      map.set(key, [...(map.get(key) || []), candidate]);
    }
    return [...map.entries()]
      .map(([id, candidates]) => ({
        id,
        candidates: candidates.sort((left, right) => left.variantRank - right.variantRank || right.score - left.score),
        score: Math.max(...candidates.map((candidate) => candidate.score)),
        start: Math.min(...candidates.map((candidate) => candidate.start)),
      }))
      .sort((left, right) => right.score - left.score || left.start - right.start);
  }, [projectQuery.data?.candidates]);

  const activeCandidate = projectQuery.data?.candidates.find((candidate) => candidateId(candidate) === activeCandidateId) || null;

  const saveMutation = useMutation({
    mutationFn: () => api.saveShortsFeedback(preferredProject || '', {
      candidateIds: [...selected],
      feedback,
    }),
    onSuccess: (project) => {
      queryClient.setQueryData(['shorts-project', project.id], project);
      queryClient.invalidateQueries({ queryKey: ['shorts-projects'] });
    },
  });
  const renderMutation = useMutation({
    mutationFn: () => api.renderShortsCandidates(preferredProject || '', {
      candidateIds: [...selected],
      feedback,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shorts-projects'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job-status'] });
    },
  });

  function preview(candidate: ShortsCandidate) {
    const video = videoRef.current;
    if (!video) return;
    const id = candidateId(candidate);
    const itemFeedback = feedback[id];
    const start = itemFeedback?.editedStart ?? candidate.start;
    const end = itemFeedback?.editedEnd ?? candidate.end;
    video.currentTime = start;
    previewEndRef.current = end;
    setActiveCandidateId(id);
    video.play().catch(() => undefined);
  }

  function patchFeedback(id: string, patch: Partial<ShortsCandidateFeedback>) {
    setFeedback((current) => ({
      ...current,
      [id]: {
        ...(current[id] || { decision: 'unreviewed', rating: 0 }),
        ...patch,
      },
    }));
  }

  function patchBoundary(candidate: ShortsCandidate, field: 'editedStart' | 'editedEnd', value: number) {
    const id = candidateId(candidate);
    patchFeedback(id, {
      editedStart: feedback[id]?.editedStart ?? candidate.start,
      editedEnd: feedback[id]?.editedEnd ?? candidate.end,
      [field]: value,
    });
  }

  function approve(candidate: ShortsCandidate) {
    const id = candidateId(candidate);
    setSelected((current) => new Set(current).add(id));
    patchFeedback(id, { decision: 'approved', rating: 1 });
  }

  function reject(candidate: ShortsCandidate) {
    const id = candidateId(candidate);
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    patchFeedback(id, { decision: 'rejected', rating: -1 });
  }

  if (projectsQuery.isLoading) {
    return <PageState title="Loading candidate reviews" detail="Reading saved source analyses." loading />;
  }
  if (projectsQuery.isError) {
    return <PageState title="Candidate reviews unavailable" detail={(projectsQuery.error as Error).message} error />;
  }
  if (!projectsQuery.data?.length) {
    return <PageState title="No candidate reviews yet" detail="Enable Review before rendering on a Shorts job. The completed analysis will appear here." />;
  }
  if (projectQuery.isError) {
    return <PageState title="Candidate review unavailable" detail={(projectQuery.error as Error).message} error />;
  }

  const project = projectQuery.data;
  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 border-b border-white/5 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-emerald-300">
            <ListChecks className="h-4 w-4" /> Candidate review
          </div>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">Choose distinct stories before rendering</h1>
          <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-slate-400">One recommended length is shown first in each story. Alternate durations stay attached instead of becoming duplicate exports.</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button className="btn-secondary" disabled={saveMutation.isPending || !project} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save review
          </button>
          <button className="btn-primary" disabled={!selected.size || renderMutation.isPending || !project} onClick={() => renderMutation.mutate()}>
            {renderMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />} Render {selected.size} selected
          </button>
        </div>
      </header>

      {(saveMutation.isError || renderMutation.isError) && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {(saveMutation.error as Error | null)?.message || (renderMutation.error as Error | null)?.message}
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-2 xl:sticky xl:top-5 xl:self-start">
          <div className="label">Saved analyses</div>
          {projectsQuery.data.map((item) => (
            <button
              key={item.id}
              className={clsx(
                'flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-3 text-left transition active:scale-[0.98]',
                item.id === preferredProject
                  ? 'border-emerald-400/25 bg-emerald-500/10 text-white'
                  : 'border-white/5 bg-white/[0.025] text-slate-400 hover:border-white/10 hover:bg-white/5',
              )}
              onClick={() => navigate(`/review/${encodeURIComponent(item.id)}`)}
            >
              <Layers3 className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{item.sourceName}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-slate-500">{item.clusterCount} stories · {item.exportedCount} rendered</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </button>
          ))}
        </aside>

        <main className="min-w-0 space-y-5">
          {!project ? (
            <div className="h-96 animate-pulse rounded-2xl bg-white/5" />
          ) : (
            <>
              <section className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <div className="grid min-w-0 lg:grid-cols-[minmax(0,0.92fr)_minmax(300px,1.08fr)]">
                  <div className="min-w-0 bg-slate-950">
                    <video
                      ref={videoRef}
                      src={project.sourceUrl}
                      className="aspect-video h-full max-h-[430px] w-full object-contain"
                      controls
                      preload="metadata"
                      playsInline
                      onTimeUpdate={(event) => {
                        if (previewEndRef.current !== null && event.currentTarget.currentTime >= previewEndRef.current) {
                          event.currentTarget.pause();
                          previewEndRef.current = null;
                        }
                      }}
                    />
                  </div>
                  <div className="min-w-0 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip"><Sparkles className="h-3.5 w-3.5" /> {project.clusterCount} unique stories</span>
                      <span className="chip"><Check className="h-3.5 w-3.5" /> {selected.size} selected</span>
                    </div>
                    {activeCandidate ? (
                      <div className="mt-4 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-slate-500">
                          <span>{formatTime(activeCandidate.start)}–{formatTime(activeCandidate.end)}</span>
                          <span>{activeCandidate.duration.toFixed(1)} sec</span>
                          <span className="text-emerald-300">score {activeCandidate.score.toFixed(1)}</span>
                        </div>
                        <p className="mt-3 max-h-36 overflow-y-auto break-words text-sm leading-relaxed text-slate-200 [overflow-wrap:anywhere]">{activeCandidate.text}</p>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <BoundaryInput
                            label="Start"
                            value={feedback[candidateId(activeCandidate)]?.editedStart ?? activeCandidate.start}
                            min={Math.max(0, activeCandidate.start - 12)}
                            max={(feedback[candidateId(activeCandidate)]?.editedEnd ?? activeCandidate.end) - 0.5}
                            onChange={(value) => patchBoundary(activeCandidate, 'editedStart', value)}
                          />
                          <BoundaryInput
                            label="End"
                            value={feedback[candidateId(activeCandidate)]?.editedEnd ?? activeCandidate.end}
                            min={(feedback[candidateId(activeCandidate)]?.editedStart ?? activeCandidate.start) + 0.5}
                            max={activeCandidate.end + 12}
                            onChange={(value) => patchBoundary(activeCandidate, 'editedEnd', value)}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid min-h-48 place-items-center text-sm text-slate-600">Choose a candidate to preview.</div>
                    )}
                  </div>
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="flex flex-col gap-1 border-b border-white/5 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
                  <div>
                    <div className="text-sm font-semibold text-white">Story clusters</div>
                    <div className="text-xs text-slate-500">Recommended version first; open alternates only when a different length is useful.</div>
                  </div>
                  <div className="font-mono text-[10px] text-slate-600">{project.candidateCount} variants across {project.clusterCount} stories</div>
                </div>
                <div className="divide-y divide-white/5">
                  {groups.map((group, groupIndex) => (
                    <StoryGroup
                      key={group.id}
                      index={groupIndex}
                      candidates={group.candidates}
                      selected={selected}
                      feedback={feedback}
                      activeCandidateId={activeCandidateId}
                      onPreview={preview}
                      onApprove={approve}
                      onReject={reject}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function StoryGroup({ index, candidates, selected, feedback, activeCandidateId, onPreview, onApprove, onReject }: {
  index: number;
  candidates: ShortsCandidate[];
  selected: Set<string>;
  feedback: FeedbackMap;
  activeCandidateId: string | null;
  onPreview: (candidate: ShortsCandidate) => void;
  onApprove: (candidate: ShortsCandidate) => void;
  onReject: (candidate: ShortsCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const visible = open ? candidates : candidates.slice(0, 1);
  return (
    <div className="min-w-0 px-3 py-4 sm:px-5" style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
      <div className="space-y-2">
        {visible.map((candidate) => {
          const id = candidateId(candidate);
          const approved = selected.has(id);
          const rejected = feedback[id]?.decision === 'rejected';
          return (
            <div
              key={id}
              className={clsx(
                'grid min-w-0 gap-3 rounded-xl border p-3 transition lg:grid-cols-[auto_minmax(0,1fr)_auto]',
                activeCandidateId === id ? 'border-emerald-400/30 bg-emerald-500/[0.07]' : 'border-white/5 bg-slate-950/35',
                candidate.exported && 'opacity-60',
              )}
            >
              <button className="grid h-10 w-10 place-items-center rounded-lg bg-white/5 text-slate-200 transition hover:bg-white/10 active:scale-[0.98]" onClick={() => onPreview(candidate)} title="Preview this candidate">
                <Play className="h-4 w-4" />
              </button>
              <button className="min-w-0 text-left" onClick={() => onPreview(candidate)}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-500">{formatTime(candidate.start)} · {candidate.duration.toFixed(1)} sec</span>
                  <span className="font-mono text-[10px] text-emerald-300">{candidate.score.toFixed(1)}</span>
                  {candidate.variantRank === 1 && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400">Recommended</span>}
                  {candidate.exported && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-300">Rendered</span>}
                </span>
                <span className="mt-1.5 block break-words text-xs leading-relaxed text-slate-300 line-clamp-2 [overflow-wrap:anywhere]">{candidate.text}</span>
              </button>
              <div className="flex min-w-0 items-center gap-1 lg:justify-end">
                <button className={clsx('btn h-8 px-2 text-[10px]', approved ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/5 text-slate-400')} onClick={() => onApprove(candidate)} disabled={candidate.exported} title="Approve">
                  <ThumbsUp className="h-3.5 w-3.5" /> Keep
                </button>
                <button className={clsx('btn h-8 px-2 text-[10px]', rejected ? 'bg-red-500/15 text-red-200' : 'bg-white/5 text-slate-400')} onClick={() => onReject(candidate)} disabled={candidate.exported} title="Reject">
                  <ThumbsDown className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {candidates.length > 1 && (
        <button className="mt-2 text-[10px] font-semibold text-slate-500 transition hover:text-slate-300" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide alternate lengths' : `Show ${candidates.length - 1} alternate length${candidates.length === 2 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

function BoundaryInput({ label, value, min, max, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="label">{label} (sec)</span>
      <input
        className="input font-mono text-xs"
        type="number"
        value={Number(value.toFixed(3))}
        min={min}
        max={max}
        step={0.05}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
        }}
      />
    </label>
  );
}

function PageState({ title, detail, loading = false, error = false }: { title: string; detail: string; loading?: boolean; error?: boolean }) {
  return (
    <div className="mx-auto grid min-h-[65dvh] max-w-3xl place-items-center px-4 py-12 text-center">
      <div>
        <div className={clsx('mx-auto grid h-12 w-12 place-items-center rounded-2xl border', error ? 'border-red-500/20 bg-red-500/10 text-red-300' : 'border-white/10 bg-white/5 text-slate-300')}>
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : error ? <CircleAlert className="h-5 w-5" /> : <Clock3 className="h-5 w-5" />}
        </div>
        <h1 className="mt-4 text-xl font-black tracking-tight text-white">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">{detail}</p>
      </div>
    </div>
  );
}
