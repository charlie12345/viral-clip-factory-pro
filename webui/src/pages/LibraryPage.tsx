import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Filter, SortDesc, Trash2, Download, RefreshCcw, PencilRuler,
  Captions, FileDown, Loader2, Check, X, ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, type ClipSummary } from '@/api/client';
import { useClips } from '@/hooks/queries';

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
    setSelected(new Set(filtered.map((c) => c.name)));
  }
  function clearSelection() { setSelected(new Set()); }

  // Filtering
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clips
      .filter((c) => parseFloat(String(c.score)) >= minScore)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.reasons || []).some((r) => r.toLowerCase().includes(q)))
      .sort((a, b) => {
        const sa = parseFloat(String(a.score));
        const sb = parseFloat(String(b.score));
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
    onSuccess: () => {
      clearSelection();
      qc.invalidateQueries({ queryKey: ['clips'] });
    },
  });
  const batchReRender = useMutation({
    mutationFn: (clipNames: string[]) => api.batchReRender({ clipNames }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-status'] });
    },
  });

  function openEditor(name: string) {
    navigate(`/editor/${encodeURIComponent(name)}`);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-white">Library</h1>
          <p className="mt-1 text-sm text-slate-400">{clips.length} clips · sorted by viral score</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => refetch()}>
            <RefreshCcw className={clsx('h-4 w-4', isFetching && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="panel p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
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
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary"
            onClick={() => setShowFilters((s) => !s)}
          >
            <Filter className="h-4 w-4" />
            Filters
            <ChevronDown className={clsx('h-3 w-3 transition', showFilters && 'rotate-180')} />
          </button>
          <SortMenu sort={sort} onChange={setSort} />
        </div>
      </div>

      {/* Filter row */}
      {showFilters && (
        <div className="panel p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 animate-fade-in">
          <div>
            <div className="label">Minimum Score: {minScore.toFixed(1)}</div>
            <input
              type="range"
              min="0"
              max="20"
              step="0.5"
              value={minScore}
              onChange={(e) => setMinScore(parseFloat(e.target.value))}
              className="w-full accent-pink-500"
            />
          </div>
        </div>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="panel-elev p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-slide-up">
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
            <button
              className="btn-ghost text-xs"
              onClick={() => selectAll(filtered)}
            >Select all visible</button>
            <button className="btn-ghost text-xs" onClick={clearSelection}>Clear</button>
            <a
              className="btn-secondary text-xs"
              href={`/api/clips/batch-download?names=${encodeURIComponent(Array.from(selected).join(','))}`}
            >
              <Download className="h-3.5 w-3.5" /> Download ZIP
            </a>
            <button
              className="btn-secondary text-xs"
              disabled={batchReRender.isPending}
              onClick={() => batchReRender.mutate(Array.from(selected))}
            >
              {batchReRender.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Re-render All
            </button>
            <button
              className="btn-danger text-xs"
              disabled={batchDelete.isPending}
              onClick={() => {
                if (confirm(`Delete ${selected.size} clips? This cannot be undone.`)) {
                  batchDelete.mutate(Array.from(selected));
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="grid place-items-center py-16 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState hasClips={clips.length > 0} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((clip, idx) => (
            <ClipCard
              key={clip.name}
              clip={clip}
              rank={idx + 1}
              selected={selected.has(clip.name)}
              onToggle={() => toggle(clip.name)}
              onEdit={() => openEditor(clip.name)}
              onDelete={async () => {
                if (confirm('Delete this clip?')) {
                  await api.deleteClip(clip.name);
                  qc.invalidateQueries({ queryKey: ['clips'] });
                }
              }}
              active={clipName === clip.name}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SortMenu({ sort, onChange }: { sort: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <div className="relative group">
      <button className="btn-secondary">
        <SortDesc className="h-4 w-4" />
        <span className="hidden sm:inline">Sort</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      <div className="absolute right-0 mt-1 hidden group-hover:block hover:block z-20 w-48 rounded-lg border border-white/10 bg-bg-elev shadow-2xl">
        {([
          ['score-desc', 'Highest score first'],
          ['score-asc',  'Lowest score first'],
          ['name-asc',   'Name (A→Z)'],
          ['name-desc',  'Name (Z→A)'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => onChange(k)}
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
    <div className="panel-elev grid place-items-center gap-3 py-16 text-slate-500">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/5">
        <Captions className="h-6 w-6" />
      </div>
      {hasClips ? (
        <p>No clips match your filters.</p>
      ) : (
        <>
          <p>No clips yet. Upload a video to get started.</p>
          <a href="/dashboard" className="btn-primary text-sm">Go to Dashboard</a>
        </>
      )}
    </div>
  );
}

function ClipCard({
  clip, rank, selected, onToggle, onEdit, onDelete, active,
}: {
  clip: ClipSummary;
  rank: number;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  active?: boolean;
}) {
  const score = parseFloat(String(clip.score));
  const scoreColor =
    score >= 10 ? 'from-pink-500 to-orange-500'
    : score >= 7.5 ? 'from-purple-500 to-pink-500'
    : 'from-blue-500 to-purple-500';
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
      <div className="relative aspect-[9/16] bg-black">
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
          className="absolute inset-0 h-full w-full object-cover opacity-0 group-hover:opacity-100 transition"
          controls
          preload="none"
          playsInline
          muted
        />
        {/* Top-N badge */}
        {rank <= 3 && (
          <div className={clsx('absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-black text-white shadow-lg', scoreColor)}>
            🏆 TOP {rank}
          </div>
        )}
        {/* Selection checkbox */}
        <button
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
        </button>
        {/* Score badge */}
        <div className="absolute bottom-2 left-2">
          <div className={clsx('inline-flex items-center gap-1 rounded-full bg-gradient-to-r px-2 py-0.5 text-xs font-black text-white shadow-lg', scoreColor)}>
            🔥 {isNaN(score) ? clip.score : score.toFixed(1)}
          </div>
        </div>
        {/* Bake / Raw badge (bottom-right, opposite the score) */}
        <div className="absolute bottom-2 right-2">
          <div
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold shadow-lg backdrop-blur',
              clip.baked
                ? 'bg-emerald-500/85 text-white ring-1 ring-emerald-300/40'
                : 'bg-slate-700/80 text-slate-200 ring-1 ring-white/10',
            )}
            title={clip.baked
              ? 'Subtitles baked into this clip — audio + burned-in captions'
              : 'Raw render — open in Editor and use Apply & Re-render or Bake & Download to burn subtitles'}
          >
            {clip.baked ? '🔤 BAKED' : '📹 RAW'}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-3 flex flex-col gap-2">
        {clip.rankingVersion && (
          <div className="text-[9px] uppercase tracking-[0.18em] text-slate-500">
            {clip.rankingVersion.replace('_', ' ')}
          </div>
        )}
        {clip.reasons?.length > 0 && (
          <p className="text-[11px] text-slate-400 line-clamp-2 leading-snug">
            {clip.reasons.slice(0, 3).join(' • ')}
          </p>
        )}
        <p className="text-[10px] font-mono text-slate-500 truncate" title={clip.name}>{clip.name}</p>
        <div className="mt-1 grid grid-cols-3 gap-1.5">
          <a
            href={clip.url} download
            className="grid place-items-center rounded-md bg-white/5 py-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition"
            title="Download MP4"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={onEdit}
            className="grid place-items-center rounded-md bg-brand-500/15 py-1.5 text-brand-300 hover:bg-brand-500/25 hover:text-white transition"
            title="Edit captions"
          >
            <PencilRuler className="h-3.5 w-3.5" />
          </button>
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
