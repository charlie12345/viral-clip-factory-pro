// Typed API client wrapping all /api/* endpoints exposed by the existing
// Express server (dashboard/server.js). No backend changes required.

import type { RenderSettings } from '@/lib/render-options';

export interface ClipSummary {
  name: string;
  url: string;
  score: number | string;
  candidateScore: number | null;
  reasons: string[];
  scoreBreakdown: Record<string, unknown> | null;
  rankingVersion: string | null;
  hasSubtitleData: boolean;
  baked: boolean;
}

export interface ClipWord {
  word: string;
  start: number;
  end: number;
}

export interface ClipMetadata extends ClipSummary {
  start: number;
  end: number;
  duration: number;
  source?: string;
  style?: string;
  animation?: string;
  font?: string | null;
  subtitle_x?: number | null;
  subtitle_y?: number | null;
  subtitle_width?: number | null;
  subtitle_fontsize?: number | null;
  video_zoom?: number | string | null;
  video_pan_x?: number | string | null;
  video_pan_y?: number | string | null;
  words: ClipWord[];
  text?: string;
}

export interface ActiveJobState {
  active: boolean;
  recovered: boolean;
  label: string | null;
  source: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface UploadSession {
  sessionId: string;
  safeName: string;
  totalSize: number;
  receivedBytes: number;
  chunkSize: number;
  status: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'error';
}

export interface Profile {
  id: string;
  name: string;
  settings: RenderSettings;
  createdAt: string;
  updatedAt: string;
}

export interface JobHistoryEntry {
  id: string;
  kind: 'render' | 'rerender' | 'upload' | 'bake' | 'url';
  label: string;
  source?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string | null;
}

export interface BatchReRenderBody {
  clipNames: string[];
  style?: string;
  font?: string | null;
  animation?: string;
  subtitle_x?: number | null;
  subtitle_y?: number | null;
  subtitle_width?: number | null;
  subtitle_fontsize?: number | null;
}

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string')
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export const api = {
  // Clips
  listClips: () => request<ClipSummary[]>('/api/clips'),
  getClipMeta: (name: string) => request<ClipMetadata>(`/api/clips/${encodeURIComponent(name)}/subtitles`),
  deleteClip: (name: string) => request<{ status: string }>(`/api/clips/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  reRenderClip: (name: string, body: Record<string, unknown>) =>
    request<{ status: string; message: string }>(`/api/clips/${encodeURIComponent(name)}/subtitles`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startBakeDownload: (name: string, body: Record<string, unknown>) =>
    request<{ jobId: string }>(`/api/clips/${encodeURIComponent(name)}/render-download`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bakeProgress: (jobId: string) =>
    request<{ progress: number; done: boolean; error: string | null }>(`/api/bake-progress/${encodeURIComponent(jobId)}`),
  bakeDownloadUrl: (jobId: string, name: string) =>
    `/api/bake-download/${encodeURIComponent(jobId)}?name=${encodeURIComponent(name)}`,

  // Thumbnail (served by the new thumbnail endpoint)
  clipThumbnailUrl: (name: string) => `/api/clips/${encodeURIComponent(name)}/thumbnail?t=${Date.now()}`,

  // Batch operations (new endpoints, see server.js)
  batchDelete: (names: string[]) =>
    request<{ deleted: number }>(`/api/clips/batch`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', clipNames: names }),
    }),
  batchReRender: (body: BatchReRenderBody) =>
    request<{ status: string; queued: number }>(`/api/clips/batch`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rerender', ...body }),
    }),
  batchDownloadUrl: () => `/api/clips/batch-download`,

  // Jobs
  jobStatus: () => request<ActiveJobState>('/api/job-status'),
  cancelJob: () => request<{ status: string }>('/api/job/cancel', { method: 'POST' }),
  listJobs: () => request<JobHistoryEntry[]>('/api/jobs'),

  // Logs
  getLogs: (limit = 80) => request<string[]>(`/api/logs?limit=${limit}`),

  // Upload (resumable chunked)
  initUpload: (body: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    lastModified?: number;
    fingerprint?: string;
    sessionId?: string;
  } & RenderSettings) =>
    request<UploadSession>('/api/upload-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  uploadStatus: (sessionId: string) =>
    request<UploadSession>(`/api/upload-sessions/${encodeURIComponent(sessionId)}`),
  uploadChunk: (sessionId: string, chunk: Blob, offset: number) => {
    const form = new FormData();
    form.append('chunk', chunk, 'chunk.bin');
    form.append('offset', String(offset));
    form.append('chunkSize', String(chunk.size));
    return fetch(`/api/upload-sessions/${encodeURIComponent(sessionId)}/chunk`, {
      method: 'POST',
      body: form,
    }).then(async (r) => {
      const text = await r.text();
      const body = safeParse(text);
      if (!r.ok) throw new ApiError((body as { error?: string })?.error ?? 'Chunk upload failed', r.status, body);
      return body as { status: string; receivedBytes: number; totalSize: number; complete: boolean };
    });
  },
  finalizeUpload: (sessionId: string) =>
    request<{ status: string; message: string }>(`/api/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
    }),

  // URL ingest
  processUrl: (body: { url: string } & RenderSettings) =>
    request<{ status: string; message: string }>('/api/process-url', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Profiles
  listProfiles: () => request<Profile[]>('/api/profiles'),
  saveProfile: (profile: Profile) =>
    request<Profile>(`/api/profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    }),
  deleteProfile: (id: string) =>
    request<{ status: string }>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request<Record<string, unknown>>('/api/settings'),
  saveSettings: (settings: Record<string, unknown>) =>
    request<{ status: string }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

export { ApiError };
