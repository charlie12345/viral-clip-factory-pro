import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { DashboardPage } from '@/pages/DashboardPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { EditorPage } from '@/pages/EditorPage';
import { JobsPage } from '@/pages/JobsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LongformEditorPage } from '@/pages/LongformEditorPage';
import { ShortsReviewPage } from '@/pages/ShortsReviewPage';
import { ActionCompilationPage } from '@/pages/ActionCompilationPage';
import { LongformReviewPage } from '@/pages/LongformReviewPage';

export default function App() {
  return (
    <Routes>
      <Route path="/longform-review/:token" element={<LongformReviewPage />} />
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
  );
}
