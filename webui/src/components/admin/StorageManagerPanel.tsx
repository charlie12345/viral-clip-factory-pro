import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Database, HardDrive, Loader2, RefreshCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/api/client';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function StorageManagerPanel({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const storage = useQuery({
    queryKey: ['admin-storage'],
    queryFn: () => api.getAdminStorage(),
    staleTime: 15_000,
  });
  const cleanup = useMutation({
    mutationFn: () => api.cleanupAdminStorage([...selected], confirmation),
    onMutate: () => setNotice(null),
    onSuccess: (result) => {
      qc.setQueryData(['admin-storage'], result.storage);
      setSelected(new Set());
      setConfirmation('');
      setNotice(`${formatBytes(result.cleanup.freedBytes)} of regenerable files removed.`);
    },
  });
  const data = storage.data;
  const selectedBytes = data?.categories
    .filter((category) => selected.has(category.id))
    .reduce((total, category) => total + category.bytes, 0) || 0;
  const expectedConfirmation = data?.confirmation || 'DELETE_REGENERABLE_FILES';
  const canClean = Boolean(
    selected.size
    && confirmation === expectedConfirmation
    && !data?.busyReason
    && !cleanup.isPending,
  );

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className={clsx(
      'space-y-4',
      embedded ? 'p-4 sm:p-5' : 'panel p-5',
    )} aria-labelledby="storage-manager-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="storage-manager-heading" className="flex items-center gap-2 text-sm font-bold text-white">
            <HardDrive className="h-4 w-4 text-sky-300" /> Admin storage manager
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">Inspect and remove only allowlisted cache and work-file categories. Source media, projects, LUTs, snapshots, reviews, deliveries, and finished masters are protected.</p>
        </div>
        <button className="btn-secondary h-8 px-2 text-[10px]" disabled={storage.isFetching} onClick={() => storage.refetch()}>
          {storage.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />} Rescan
        </button>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
        <p className="text-[10px] leading-relaxed text-slate-400">This dashboard has no account sign-in layer. Treat cleanup as an administrator action and expose the app only to trusted Tailnet users.</p>
      </div>

      {storage.isLoading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse rounded-lg bg-white/5" />)}
        </div>
      ) : storage.error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-xs text-red-300" role="alert">
          Storage could not be inspected: {(storage.error as Error).message}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.categories.map((category) => (
              <label
                key={category.id}
                className={clsx(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition',
                  selected.has(category.id)
                    ? 'border-sky-400/35 bg-sky-500/[0.08]'
                    : 'border-white/[0.06] bg-black/20 hover:border-white/15',
                )}
              >
                <input
                  className="mt-1 h-4 w-4 shrink-0 accent-sky-500"
                  type="checkbox"
                  checked={selected.has(category.id)}
                  onChange={() => toggle(category.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-200">{category.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-sky-200">{formatBytes(category.bytes)}</span>
                  </span>
                  <span className="mt-1 block text-[10px] leading-relaxed text-slate-500">{category.description}</span>
                  <span className="mt-1 block text-[10px] leading-relaxed text-amber-200/65">{category.warning}</span>
                  <span className="mt-1.5 block font-mono text-[10px] text-slate-700">{category.files} files · {category.directories} folders</span>
                </span>
              </label>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
            <div className="rounded-lg border border-emerald-500/10 bg-emerald-500/[0.035] p-3">
              <div className="flex items-center gap-2 text-[10px] font-semibold text-emerald-200"><Database className="h-3.5 w-3.5" /> Protected by policy</div>
              <ul className="mt-2 space-y-1 text-[10px] leading-relaxed text-slate-500">
                {data.protected.map((item) => <li key={item}>• {item}</li>)}
              </ul>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-black/25 p-3">
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="font-semibold text-slate-300">Selected for cleanup</span>
                <span className="font-mono text-red-200">{formatBytes(selectedBytes)}</span>
              </div>
              {data.busyReason && (
                <div className="mt-2 flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-100">
                  <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {data.busyReason}. Cleanup is locked until it finishes.
                </div>
              )}
              <label className="mt-3 block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-600">Type to confirm</span>
                <input
                  className="input h-9 font-mono text-[10px]"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder={expectedConfirmation}
                  spellCheck={false}
                />
              </label>
              <button className="btn-danger mt-2 h-9 w-full text-[10px]" disabled={!canClean} onClick={() => cleanup.mutate()}>
                {cleanup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete selected work files
              </button>
            </div>
          </div>
        </>
      ) : null}

      {notice && <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.07] px-3 py-2 text-[10px] text-emerald-200">{notice}</div>}
      {cleanup.error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[10px] text-red-300" role="alert">{(cleanup.error as Error).message}</div>}
    </section>
  );
}
