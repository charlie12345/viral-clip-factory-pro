import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import { Flame, LayoutDashboard, Film, PencilRuler, Activity, Settings, Github } from 'lucide-react';
import { useActiveJob } from '@/hooks/queries';
import { useEffect } from 'react';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/library',   label: 'Library',   icon: Film },
  { to: '/jobs',      label: 'Jobs',      icon: Activity },
  { to: '/settings',  label: 'Settings',  icon: Settings },
];

export function AppLayout() {
  const location = useLocation();
  const { data: job } = useActiveJob();

  // Close the editor by stripping the route when on editor and pressing Escape is awkward
  // — we just rely on the back button inside the editor page.

  // Title reflects current page
  useEffect(() => {
    const title = `Viral Clip Factory${location.pathname === '/dashboard' ? '' : ' — ' + (NAV.find(n => location.pathname.startsWith(n.to))?.label ?? '')}`;
    document.title = title;
  }, [location.pathname]);

  return (
    <div className="flex h-full min-h-screen w-full bg-app-bg text-slate-100">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/5 bg-bg-panel/70 backdrop-blur-md">
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
            <span>Server: localhost:3000</span>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-2 border-b border-white/5 bg-bg-panel/95 px-3 backdrop-blur">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent-pink to-accent-blue">
          <Flame className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-bold">Viral Clip Factory</span>
        <nav className="ml-auto flex gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx('grid h-8 w-8 place-items-center rounded-md', isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5')
              }
              title={label}
            >
              <Icon className="h-4 w-4" />
            </NavLink>
          ))}
        </nav>
      </div>

      <main className="flex-1 min-w-0 pt-12 md:pt-0">
        <Outlet />
      </main>
    </div>
  );
}
