import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { Flame, LayoutDashboard, Film, ListChecks, Activity, Settings, Clapperboard } from 'lucide-react';
import { api } from '@/api/client';
import { useActiveJob } from '@/hooks/queries';
import { useEffect, useRef } from 'react';
import { Toaster } from '@/components/ui';
import { toast } from '@/store/toasts';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, mobileLabel: null },
  { to: '/library',   label: 'Library',   icon: Film,            mobileLabel: null },
  { to: '/review',    label: 'Review',    icon: ListChecks,      mobileLabel: null },
  { to: '/compilations', label: 'AI Montage', icon: Clapperboard, mobileLabel: 'Montage' },
  { to: '/jobs',      label: 'Jobs',      icon: Activity,        mobileLabel: null },
  { to: '/settings',  label: 'Settings',  icon: Settings,        mobileLabel: null },
];

export function AppLayout() {
  const location = useLocation();
  const { data: job } = useActiveJob();
  const { data: legal } = useQuery({
    queryKey: ['legal-info'],
    queryFn: () => api.legalInfo(),
    staleTime: Infinity,
    retry: 0,
  });
  const isLongformEditor = location.pathname.startsWith('/longform-editor/');
  const shortcutsHelp = useGlobalShortcuts();
  const sourceUrl = legal?.sourceUrl ?? 'https://github.com/charlie12345/viral-clip-factory-pro/tree/main';
  const yoloSource = legal?.thirdPartySources.find((source) => source.name === 'Ultralytics YOLO');

  // Title reflects current page
  useEffect(() => {
    const title = `Viral Clip Factory${location.pathname === '/dashboard' ? '' : ' — ' + (NAV.find(n => location.pathname.startsWith(n.to))?.label ?? '')}`;
    document.title = title;
  }, [location.pathname]);

  // Toast when a running job finishes. The previous-active ref suppresses
  // notifications on first mount, and the notified-job ref prevents repeats
  // while the finished status keeps polling in.
  const prevActiveRef = useRef<boolean | null>(null);
  const notifiedJobRef = useRef<string | null>(null);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = job ? job.active : null;
    if (wasActive !== true || !job || job.active || !job.jobId) return;
    if (notifiedJobRef.current === job.jobId) return;
    notifiedJobRef.current = job.jobId;
    const label = job.label || 'Job';
    if (job.exitCode === 0 && !job.error) {
      toast('success', `${label} finished`, 'Open the Library to see the results.');
    } else {
      toast('error', `${label} failed`, job.error || `Exit code ${job.exitCode ?? 'unknown'}`);
    }
  }, [job]);

  return (
    <div className="flex min-h-[100dvh] w-full min-w-0 bg-app-bg text-slate-100">
      {/* Sidebar */}
      <aside className={clsx(
        'min-h-[100dvh] w-60 shrink-0 flex-col border-r border-white/5 bg-bg-panel/70 backdrop-blur-md',
        isLongformEditor ? 'hidden' : 'hidden md:flex',
      )}>
        <div className="px-5 pt-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent-pink via-brand-500 to-accent-blue shadow-glow-brand">
              <Flame className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-sm font-black tracking-tight text-white">Viral Clip</div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Factory</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => clsx('nav-item', isActive && 'active')}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              {to === '/jobs' && job?.active && (
                <span className="ml-auto h-2 w-2 rounded-full bg-accent-pink animate-pulse-soft" />
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/5 p-3 text-[11px] text-slate-500">
          <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span>Server: {window.location.host}</span>
          </div>
          <a
            className="mt-2 block px-1 text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-white"
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Source & license (AGPL-3.0)
          </a>
          {yoloSource && (
            <a
              className="mt-1 block px-1 text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-white"
              href={yoloSource.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {yoloSource.name} v{yoloSource.version} source
            </a>
          )}
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className={clsx(
        'fixed inset-x-0 top-0 z-30 h-12 min-w-0 items-center gap-1 overflow-hidden border-b border-white/5 bg-bg-panel/95 px-3 backdrop-blur md:hidden',
        isLongformEditor ? 'hidden' : 'flex',
      )}>
        <div className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent-pink to-accent-blue min-[340px]:grid">
          <Flame className="h-4 w-4 text-white" />
        </div>
        <span className="hidden min-w-0 flex-1 truncate text-sm font-bold sm:block">Viral Clip Factory</span>
        <nav className="ml-auto flex shrink-0 gap-0">
          {NAV.map(({ to, label, icon: Icon, mobileLabel }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => clsx(
                mobileLabel
                  ? 'flex h-11 w-14 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] font-bold leading-none'
                  : 'grid h-11 w-10 place-items-center rounded-md',
                isActive
                  ? mobileLabel ? 'bg-fuchsia-500/20 text-fuchsia-100 ring-1 ring-fuchsia-400/35' : 'bg-white/10 text-white'
                  : mobileLabel ? 'bg-fuchsia-500/[0.07] text-fuchsia-200 hover:bg-fuchsia-500/15' : 'text-slate-400 hover:bg-white/5',
              )}
              title={label}
              aria-label={label}
            >
              <Icon className={mobileLabel ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
              {mobileLabel && <span>{mobileLabel}</span>}
            </NavLink>
          ))}
        </nav>
      </div>

      <main className={clsx('min-w-0 max-w-full flex-1', isLongformEditor ? 'pt-0' : 'pt-12 md:pt-0')}>
        <Outlet />
        <footer className="border-t border-white/5 px-4 py-3 text-center text-[11px] text-slate-500">
          <span>Viral Clip Factory is licensed under AGPL-3.0-only. </span>
          <a className="text-slate-300 underline decoration-slate-600 underline-offset-2 hover:text-white" href={sourceUrl} target="_blank" rel="noreferrer">
            Get the corresponding source
          </a>
          {yoloSource && <>
            <span> · </span>
            <a className="text-slate-300 underline decoration-slate-600 underline-offset-2 hover:text-white" href={yoloSource.sourceUrl} target="_blank" rel="noreferrer">
              {yoloSource.name} v{yoloSource.version} source
            </a>
          </>}
          <span> · No warranty.</span>
        </footer>
      </main>
      <Toaster />
      {shortcutsHelp}
    </div>
  );
}
