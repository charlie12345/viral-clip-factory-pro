import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { AppLayout } from '@/components/layout/AppLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui';

const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const LibraryPage = lazy(() => import('@/pages/LibraryPage').then((m) => ({ default: m.LibraryPage })));
const EditorPage = lazy(() => import('@/pages/EditorPage').then((m) => ({ default: m.EditorPage })));
const JobsPage = lazy(() => import('@/pages/JobsPage').then((m) => ({ default: m.JobsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const LongformEditorPage = lazy(() => import('@/pages/LongformEditorPage').then((m) => ({ default: m.LongformEditorPage })));
const ShortsReviewPage = lazy(() => import('@/pages/ShortsReviewPage').then((m) => ({ default: m.ShortsReviewPage })));
const ActionCompilationPage = lazy(() => import('@/pages/ActionCompilationPage').then((m) => ({ default: m.ActionCompilationPage })));
const LongformReviewPage = lazy(() => import('@/pages/LongformReviewPage').then((m) => ({ default: m.LongformReviewPage })));

function RouteFallback() {
  return (
    <div className="grid min-h-[100dvh] w-full place-items-center bg-app-bg text-slate-400">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-brand-500" />
        <span className="text-sm font-medium">Loading…</span>
      </div>
    </div>
  );
}

function LegalFooter() {
  const { data: legal } = useQuery({
    queryKey: ['legal-info'],
    queryFn: () => api.legalInfo(),
    staleTime: Infinity,
    retry: 0,
  });
  const sourceUrl = legal?.sourceUrl ?? 'https://github.com/charlie12345/viral-clip-factory-pro/tree/main';

  return (
    <footer className="border-t border-white/5 bg-app-bg px-4 py-3 text-center text-[11px] text-slate-500">
      <span>Viral Clip Factory is licensed under AGPL-3.0-only. </span>
      <a className="text-slate-300 underline decoration-slate-600 underline-offset-2 hover:text-white" href={sourceUrl} target="_blank" rel="noreferrer">
        Get the corresponding source
      </a>
      <span> · No warranty.</span>
    </footer>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/longform-review/:token" element={<><LongformReviewPage /><LegalFooter /><Toaster /></>} />
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/library/:clipName" element={<LibraryPage />} />
            <Route path="/review" element={<ShortsReviewPage />} />
            <Route path="/review/:projectId" element={<ShortsReviewPage />} />
            <Route path="/compilations" element={<ActionCompilationPage />} />
            <Route path="/editor/:clipName" element={<EditorPage />} />
            <Route path="/longform-editor/:clipName" element={<LongformEditorPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
