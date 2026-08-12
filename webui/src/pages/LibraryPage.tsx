import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Filter, SortDesc, Trash2, Download, RefreshCcw, PencilRuler,
  Captions, Loader2, Check, ChevronDown, Film, Scissors, PlusCircle, Trophy,
  Clapperboard,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, type ClipSummary } from '@/api/client';
import { useClips } from '@/hooks/queries';
import { Button, ConfirmDialog, EmptyState as UIEmptyState, Panel, Skeleton, Slider } from '@/components/ui';
import { toast } from '@/store/toasts';

type SortKey = 'score-desc' | 'score-asc' | 'name-asc' | 'name-desc';

export function LibraryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { clipName } = useParams();
  const { data: clips = [], isLoading, isFetching, refetch } = useClips();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score-desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState<number>(0);
  const [showFilters, setShowFilters] = useState(false);
  const [generateMessage, setGenerateMessage] = useState<string | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function deleteClip(name: string) {
    try {
      await api.deleteClip(name);
      qc.invalidateQueries({ queryKey: ['clips'] });
      toast('success', `Deleted ${name}`);
    } catch (error) {
      toast('error', 'Delete failed', error instanceof Error ? error.message : undefined);
    }
  }

  // Toggle selection
  function toggle(name: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function selectAll(filtered: ClipSummary[]) {
    setSelected(new Set(filtered.filter((c) => c.kind !== 'longform' && c.sourceKind !== 'action_compilation').map((c) => c.name)));
  }
  function clearSelection() { setSelected(new Set()); }

  // Filtering
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clips
      .filter((c) => c.kind === 'longform' || parseFloat(String(c.score)) >= minScore)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.reasons || []).some((r) => r.toLowerCase().includes(q)) || (c.topics || []).some((topic) => topic.toLowerCase().includes(q)))
      .sort((a, b) => {
        const sa = Number.isFinite(parseFloat(String(a.score))) ? parseFloat(String(a.score)) : -1;
        const sb = Number.isFinite(parseFloat(String(b.score))) ? parseFloat(String(b.score)) : -1;
        switch (sort) {
          case 'score-desc': return sb - sa;
          case 'score-asc':  return sa - sb;
          case 'name-asc':   return a.name.localeCompare(b.name);
          case 'name-desc':  return b.name.localeCompare(a.name);
        }
      });
  }, [clips, search, sort, minScore]);

  // Bulk actions
  const batchDelete = useMutation({
    mutationFn: (names: string[]) => api.batchDelete(names),
    onSuccess: (_result, names) => {
      clearSelection();
      qc.invalidateQueries({ queryKey: ['clips'] });
      toast('success', `Deleted ${names.length} clip${names.length === 1 ? '' : 's'}`);
    },
    onError: (error) => {
      toast('error', 'Batch delete failed', (error as Error).message);
    },
  });
  const batchReRender = useMutation({
    mutationFn: (clipNames: string[]) => api.batchReRender({ clipNames }),
    onSuccess: (_result, clipNames) => {
      qc.invalidateQueries({ queryKey: ['job-status'] });
      toast('success', `Re-render queued for ${clipNames.length} clip${clipNames.length === 1 ? '' : 's'}`, 'Track progress on the Jobs page.');
    },
    onError: (error) => {
      toast('error', 'Re-render could not be queued', (error as Error).message);
    },
  });
  const generateMore = useMutation({
    mutationFn: (name: string) => api.generateMoreClips(name, 5),
    onSuccess: (result) => {
      setGenerateMessage(`${result.requested} additional Shorts queued from the saved analysis.`);
      qc.invalidateQueries({ queryKey: ['job-status'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast('success', `${result.requested} additional Shorts queued`, 'Track progress on the Jobs page.');
    },
    onError: (error) => {
      toast('error', 'Generate More could not be queued', (error as Error).message);
    },
  });

  function openEditor(name: string) {
    const clip = clips.find((item) => item.name === name);
    navigate(clip?.kind === 'longform'
      ? `/longform-editor/${encodeURIComponent(name)}`
      : `/editor/${encodeURIComponent(name)}`);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
      <header className="flex min-w-0 items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-black tracking-tight text-white">Library</h1>
          <p className="mt-1 text-sm text-slate-400">{clips.length} exports · shorts and long-form masters</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => refetch()}>
            <RefreshCcw className={clsx('h-4 w-4', isFetching && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </header>

      {(generateMessage || generateMore.isError) && (
        <div className={clsx(
          'break-words rounded-xl border px-4 py-3 text-sm [overflow-wrap:anywhere]',
          generateMore.isError
            ? 'border-red-500/25 bg-red-500/10 text-red-200'
            : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
        )}>
          {generateMore.isError
            ? (generateMore.error instanceof Error ? generateMore.error.message : 'Generate More could not be queued.')
            : generateMessage}
        </div>
      )}

      {/* Toolbar */}
      <Panel className="p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search by name or reason…"
            className="input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
          <Button
            variant="secondary"
            onClick={() => setShowFilters((s) => !s)}
          >
            <Filter className="h-4 w-4" />
            Filters
            <ChevronDown className={clsx('h-3 w-3 transition', showFilters && 'rotate-180')} />
          </Button>
          <SortMenu sort={sort} onChange={setSort} />
        </div>
      </Panel>

      {/* Filter row */}
      {showFilters && (
        <Panel className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 animate-fade-in">
          <Slider
            label="Minimum Score"
            min={0}
            max={20}
            step={0.5}
            value={minScore}
            formatValue={(v) => v.toFixed(1)}
            onChange={setMinScore}
          />
        </Panel>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <Panel elevated className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-slide-up">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-accent-pink to-brand-500 text-xs font-black text-white">
              {selected.size}
            </span>
            <div className="text-sm">
              <div className="font-semibold text-white">{selected.size} clip{selected.size > 1 ? 's' : ''} selected</div>
              <div className="text-[11px] text-slate-500">{filtered.length - selected.size} more in view</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="text-xs"
              onClick={() => selectAll(filtered)}
            >Select all visible</Button>
            <Button variant="ghost" className="text-xs" onClick={clearSelection}>Clear</Button>
            <a
              className="btn-secondary text-xs"
              href={`/api/clips/batch-download?names=${encodeURIComponent(Array.from(selected).join(','))}`}
            >
              <Download className="h-3.5 w-3.5" /> Download ZIP
            </a>
            <Button
              variant="secondary"
              className="text-xs"
              disabled={batchReRender.isPending}
              onClick={() => batchReRender.mutate(Array.from(selected))}
            >
              {batchReRender.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Re-render All
            </Button>
            <Button
              variant="danger"
              className="text-xs"
              disabled={batchDelete.isPending}
              onClick={() => setConfirmBatchDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </Panel>
      )}

      {/* Grid */}
      {isLoading ? (
        <div
          role="status"
          aria-label="Loading clips"
          className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        >
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-white/5 bg-bg-elev/80">
              <Skeleton className="aspect-[9/16] rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-2.5 w-2/3" />
                <Skeleton className="h-2 w-1/2" />
                <Skeleton className="h-7 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState hasClips={clips.length > 0} />
      ) : (
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filtered.map((clip, idx) => (
            <ClipCard
              key={clip.name}
              clip={clip}
              rank={idx + 1}
              selected={selected.has(clip.name)}
              onToggle={() => toggle(clip.name)}
              onEdit={() => openEditor(clip.name)}
              onGenerateMore={() => generateMore.mutate(clip.name)}
              generatePending={generateMore.isPending}
              onDelete={() => setPendingDelete(clip.name)}
              active={clipName === clip.name}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmBatchDelete}
        title={`Delete ${selected.size} clip${selected.size === 1 ? '' : 's'}?`}
        body="This cannot be undone. The rendered files are removed from the library."
        confirmLabel="Delete"
        danger
        confirmDisabled={batchDelete.isPending}
        onCancel={() => setConfirmBatchDelete(false)}
        onConfirm={() => {
          batchDelete.mutate(Array.from(selected));
          setConfirmBatchDelete(false);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this clip?"
        body={pendingDelete ? `${pendingDelete} will be removed from the library. This cannot be undone.` : undefined}
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (name) void deleteClip(name);
        }}
      />
    </div>
  );
}

const SORT_OPTIONS = [
  ['score-desc', 'Highest score first'],
  ['score-asc',  'Lowest score first'],
  ['name-asc',   'Name (A→Z)'],
  ['name-desc',  'Name (Z→A)'],
] as const;

/**
 * Sort dropdown. Opens on hover for pointer users (unchanged) and on
 * click/Enter/Space/ArrowDown for keyboard users, with Escape and outside
 * clicks closing it.
 */
function SortMenu({ sort, onChange }: { sort: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  return (
    <div
      ref={containerRef}
      className="group relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            window.setTimeout(() => menuRef.current?.querySelector('button')?.focus(), 0);
          }
        }}
      >
        <SortDesc className="h-4 w-4" />
        <span className="hidden sm:inline">Sort</span>
        <ChevronDown className="h-3 w-3" />
      </Button>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Sort clips"
        className={clsx(
          'absolute right-0 z-20 mt-1 w-48 max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-bg-elev shadow-2xl',
          open ? 'block' : 'hidden group-hover:block hover:block',
        )}
      >
        {SORT_OPTIONS.map(([k, label]) => (
          <button
            key={k}
            role="menuitemradio"
            aria-checked={sort === k}
            onClick={() => { onChange(k); close(); }}
            className={clsx(
              'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition',
              sort === k ? 'bg-brand-500/15 text-white' : 'text-slate-300 hover:bg-white/5',
            )}
          >
            {label}
            {sort === k && <Check className="h-3.5 w-3.5 text-brand-400" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ hasClips }: { hasClips: boolean }) {
  return (
    <UIEmptyState
      icon={<Captions className="h-6 w-6" />}
      title={hasClips ? 'No clips match your filters.' : 'No clips yet. Upload a video to get started.'}
      action={hasClips ? undefined : <Link to="/dashboard" className="btn-primary text-sm">Go to Dashboard</Link>}
    />
  );
}

function ClipCard({
  clip, rank, selected, onToggle, onEdit, onDelete, onGenerateMore, generatePending, active,
}: {
  clip: ClipSummary;
  rank: number;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onGenerateMore: () => void;
  generatePending: boolean;
  active?: boolean;
}) {
  const score = parseFloat(String(clip.score));
  const scoreColor =
    score >= 10 ? 'from-pink-500 to-orange-500'
    : score >= 7.5 ? 'from-purple-500 to-pink-500'
    : 'from-blue-500 to-purple-500';
  const isMontage = clip.sourceKind === 'action_compilation';
  const isHorizontalMontage = isMontage && clip.kind === 'longform';
  const [thumbFailed, setThumbFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Lazy load metadata when scrolled into view
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    const v = videoRef.current;
    if (!el || !v) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            v.preload = 'metadata';
            obs.disconnect();
          }
        }
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={clsx(
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-bg-elev/80 backdrop-blur-md transition',
        active
          ? 'border-brand-500/60 shadow-glow-brand'
          : selected
            ? 'border-accent-pink/50 ring-1 ring-accent-pink/30'
            : 'border-white/5 hover:border-white/10 hover:shadow-2xl',
      )}
    >
      {/* Media */}
      <div className={clsx('relative bg-black', clip.kind === 'longform' ? 'aspect-video' : 'aspect-[9/16]')}>
        {!thumbFailed ? (
          <img
            src={api.clipThumbnailUrl(clip.name)}
            alt={clip.name}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : null}
        <video
          ref={videoRef}
          src={clip.url}
          className={clsx(
            'absolute inset-0 h-full w-full opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100',
            clip.kind === 'longform' ? 'object-contain' : 'object-cover',
          )}
          controls
          preload="none"
          playsInline
          muted
        />
        {/* Top-N badge */}
        {clip.kind !== 'longform' && clip.sourceKind !== 'action_compilation' && rank <= 3 && (
          <div className={clsx('absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-black text-white shadow-lg', scoreColor)}>
            <Trophy className="h-3 w-3" /> TOP {rank}
          </div>
        )}
        {/* Selection checkbox */}
        {clip.kind !== 'longform' && clip.sourceKind !== 'action_compilation' && <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className={clsx(
            'absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md border transition',
            selected
              ? 'border-accent-pink bg-accent-pink text-white'
              : 'border-white/30 bg-black/40 text-white/0 hover:text-white/80',
          )}
          aria-label={selected ? 'Deselect' : 'Select'}
        >
          {selected ? <Check className="h-3.5 w-3.5" /> : null}
        </button>}
        {/* Score badge */}
        <div className="absolute bottom-2 left-2">
          <div className={clsx(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-black text-white shadow-lg',
            clip.kind === 'longform' ? 'bg-slate-800/90 ring-1 ring-white/15' : `bg-gradient-to-r ${scoreColor}`,
          )}>
            {clip.kind === 'longform'
              ? <><Film className="h-3 w-3" /> {isHorizontalMontage ? 'LONG MONTAGE' : 'LONG FORM'}</>
              : (isNaN(score) ? clip.score : score.toFixed(1))}
          </div>
        </div>
        {/* Bake / Raw badge (bottom-right, opposite the score) */}
        {(isMontage || clip.kind !== 'longform') && <div className="absolute bottom-2 right-2">
          <div
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold shadow-lg backdrop-blur',
              isMontage
                ? 'bg-fuchsia-500/85 text-white ring-1 ring-fuchsia-300/40'
                : clip.baked
                ? 'bg-emerald-500/85 text-white ring-1 ring-emerald-300/40'
                : 'bg-slate-700/80 text-slate-200 ring-1 ring-white/10',
            )}
            title={isMontage
              ? (isHorizontalMontage ? 'Horizontal long-form montage' : 'Vertical wordless multi-source montage')
              : clip.baked
                ? 'Subtitles baked into this clip — audio + burned-in captions'
                : 'Raw render — open in Editor and use Apply & Re-render or Bake & Download to burn subtitles'}
          >
            {isMontage
              ? <><Clapperboard className="h-3 w-3" /> {isHorizontalMontage ? '16:9 MONTAGE' : '9:16 MONTAGE'}</>
              : clip.baked ? <><Captions className="h-3 w-3" /> BAKED</> : <><Film className="h-3 w-3" /> RAW</>}
          </div>
        </div>}
      </div>

      {/* Body */}
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          {clip.sourceKind === 'action_compilation' && (
            <span className="max-w-full truncate rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fuchsia-200 ring-1 ring-fuchsia-400/20">
              {clip.compilationName || (isHorizontalMontage ? 'Long-form montage' : 'Action compilation')}
            </span>
          )}
          {clip.kind !== 'longform' && clip.confidenceTier && (
            <span className={clsx(
              'max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1',
              clip.confidenceTier === 'best'
                ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                : clip.confidenceTier === 'strong'
                  ? 'bg-sky-500/10 text-sky-300 ring-sky-500/20'
                  : 'bg-amber-500/10 text-amber-200 ring-amber-500/20',
            )}>
              {clip.confidenceTier === 'review' ? 'Worth reviewing' : clip.confidenceTier}
            </span>
          )}
          {clip.exportPreset && (
            <span className="max-w-full truncate rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 ring-1 ring-white/5">
              {clip.exportPreset.replaceAll('_', ' ')}
            </span>
          )}
          {clip.videoEncoder && (
            <span className="max-w-full truncate rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-500/20">
              {clip.videoEncoder}
            </span>
          )}
          {clip.transcriptionProvider && (
            <span className="max-w-full truncate rounded-full bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sky-300 ring-1 ring-sky-500/20">
              {clip.transcriptionProvider.replaceAll('_', ' ')}
            </span>
          )}
          {clip.topics?.slice(0, 2).map((topic) => (
            <span key={topic} className="max-w-full truncate rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 ring-1 ring-violet-500/20" title={topic}>
              {topic}
            </span>
          ))}
        </div>
        {clip.rankingVersion && (
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            {clip.rankingVersion.replace('_', ' ')}
          </div>
        )}
        {clip.reasons?.length > 0 && (
          <p className="break-words text-[11px] leading-snug text-slate-400 line-clamp-2 [overflow-wrap:anywhere]">
            {clip.reasons.slice(0, 3).join(' • ')}
          </p>
        )}
        <p className="text-[10px] font-mono text-slate-500 truncate" title={clip.name}>{clip.name}</p>
        <div className={clsx('mt-1 grid gap-1.5', isMontage ? (isHorizontalMontage ? 'grid-cols-3' : 'grid-cols-2') : clip.canGenerateMore ? 'grid-cols-4' : 'grid-cols-3')}>
          <a
            href={clip.url} download
            className="grid place-items-center rounded-md bg-white/5 py-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition"
            title="Download MP4"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="h-3.5 w-3.5" />
          </a>
          {(!isMontage || isHorizontalMontage) && (
            <button
              type="button"
              onClick={onEdit}
              className="grid place-items-center rounded-md bg-brand-500/15 py-1.5 text-brand-300 hover:bg-brand-500/25 hover:text-white transition"
              title={clip.kind === 'longform' ? 'Edit long-form timeline' : 'Edit captions'}
            >
              {clip.kind === 'longform' ? <Scissors className="h-3.5 w-3.5" /> : <PencilRuler className="h-3.5 w-3.5" />}
            </button>
          )}
          {clip.canGenerateMore && (
            <button
              type="button"
              disabled={generatePending}
              onClick={(event) => { event.stopPropagation(); onGenerateMore(); }}
              className="grid place-items-center rounded-md bg-emerald-500/10 py-1.5 text-emerald-300 transition hover:bg-emerald-500/20 hover:text-white disabled:opacity-50"
              title={`Generate 5 more without re-transcribing (${clip.remainingCandidates || 0} candidates remain)`}
            >
              {generatePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="grid place-items-center rounded-md bg-red-500/10 py-1.5 text-red-400 hover:bg-red-500/20 hover:text-white transition"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
