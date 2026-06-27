import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './client';
import { RESUMABLE_CHUNK_SIZE } from '@/lib/render-options';
import type { RenderSettings } from '@/lib/render-options';

const FINGERPRINT_KEY = 'vcf_upload_session';

export type UploadPhase =
  | 'idle' | 'initializing' | 'resuming' | 'uploading'
  | 'finalizing' | 'processing' | 'paused' | 'error' | 'done';

export interface UploadProgress {
  phase: UploadPhase;
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  message: string;
  error?: string;
}

interface StoredSession {
  sessionId: string;
  fingerprint: string;
  safeName: string;
  totalSize: number;
  receivedBytes: number;
  chunkSize: number;
  status: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  settings: RenderSettings;
}

function fingerprint(file: File): string {
  return [file.name, file.size, file.lastModified].join(':');
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(FINGERPRINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveStoredSession(s: StoredSession | null) {
  if (!s) localStorage.removeItem(FINGERPRINT_KEY);
  else localStorage.setItem(FINGERPRINT_KEY, JSON.stringify(s));
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export interface UseResumableUpload {
  upload: (file: File, settings: RenderSettings) => Promise<void>;
  cancel: () => void;
  progress: UploadProgress;
  active: boolean;
}

export function useResumableUpload(): UseResumableUpload {
  const [progress, setProgress] = useState<UploadProgress>({
    phase: 'idle', uploadedBytes: 0, totalBytes: 0, bytesPerSecond: 0, message: '',
  });
  const [active, setActive] = useState(false);
  const abortRef = useRef({ aborted: false });

  useEffect(() => () => { abortRef.current.aborted = true; }, []);

  async function upload(file: File, settings: RenderSettings) {
    abortRef.current.aborted = false;
    setActive(true);
    const fg = fingerprint(file);
    const stored = loadStoredSession();
    let session: StoredSession | null = stored && stored.fingerprint === fg ? stored : null;
    let uploadedBytes = 0;
    let lastLoaded = 0;
    let lastTime = Date.now();

    setProgress({
      phase: 'initializing',
      uploadedBytes: 0, totalBytes: file.size, bytesPerSecond: 0,
      message: 'Preparing upload…',
    });

    try {
      const initRes = await api.initUpload({
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || '',
        lastModified: file.lastModified,
        fingerprint: fg,
        sessionId: session?.sessionId,
        ...settings,
      });
      const nextSession: StoredSession = {
        sessionId: initRes.sessionId,
        safeName: initRes.safeName,
        totalSize: initRes.totalSize,
        receivedBytes: initRes.receivedBytes,
        chunkSize: initRes.chunkSize || RESUMABLE_CHUNK_SIZE,
        status: initRes.status,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        fingerprint: fg,
        settings,
      };
      session = nextSession;
      saveStoredSession(session);
      uploadedBytes = Math.min(session.receivedBytes || 0, file.size);
      lastLoaded = uploadedBytes;
      lastTime = Date.now();

      const updateProgress = (loaded: number, phase: UploadPhase, message: string) => {
        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        const db = loaded - lastLoaded;
        const bps = dt > 0 ? db / dt : 0;
        lastLoaded = loaded; lastTime = now;
        setProgress({
          phase, uploadedBytes: loaded, totalBytes: file.size, bytesPerSecond: bps, message,
        });
      };

      const sess = session;
      updateProgress(
        uploadedBytes,
        sess.status === 'processing' ? 'resuming' : 'uploading',
        uploadedBytes > 0 ? `Resuming from ${formatSize(uploadedBytes)}…` : 'Uploading…',
      );

      while (uploadedBytes < file.size) {
        if (abortRef.current.aborted) throw new Error('cancelled');

        if (document.visibilityState !== 'visible') {
          setProgress((p) => ({ ...p, phase: 'paused', message: 'Paused — bring this tab back to continue' }));
          await waitForVisible();
        }

        const chunkEnd = Math.min(uploadedBytes + sess.chunkSize, file.size);
        const chunk = file.slice(uploadedBytes, chunkEnd);
        let attempt = 0;
        let done = false;
        while (!done) {
          try {
            const result = await api.uploadChunk(sess.sessionId, chunk, uploadedBytes);
            uploadedBytes = Math.max(uploadedBytes, result.receivedBytes || chunkEnd);
            sess.receivedBytes = uploadedBytes;
            sess.status = result.complete ? 'uploaded' : 'uploading';
            saveStoredSession(sess);
            updateProgress(uploadedBytes, 'uploading', 'Uploading…');
            done = true;
          } catch (err) {
            attempt += 1;
            try {
              const remote = await api.uploadStatus(sess.sessionId);
              if (remote.receivedBytes) {
                uploadedBytes = Math.min(remote.receivedBytes, file.size);
                sess.receivedBytes = uploadedBytes;
                sess.chunkSize = remote.chunkSize || sess.chunkSize;
                sess.status = remote.status;
                saveStoredSession(sess);
                if (uploadedBytes >= chunkEnd) { done = true; break; }
                updateProgress(uploadedBytes, 'resuming', `Resuming from ${formatSize(uploadedBytes)}…`);
              }
            } catch {}
            if (attempt < 4) {
              await delay(1000 * attempt);
              continue;
            }
            throw err;
          }
        }
      }

      updateProgress(file.size, 'finalizing', 'Finalizing upload…');
      await api.finalizeUpload(sess.sessionId);
      saveStoredSession(null);
      setProgress({
        phase: 'done', uploadedBytes: file.size, totalBytes: file.size, bytesPerSecond: 0,
        message: 'Upload complete — server is processing now.',
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setProgress((p) => ({ ...p, phase: 'error', message, error: message }));
    } finally {
      setActive(false);
    }
  }

  function cancel() {
    abortRef.current.aborted = true;
  }

  return { upload, cancel, progress, active };
}

function waitForVisible(): Promise<void> {
  if (document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((resolve) => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVis);
      resolve();
    };
    document.addEventListener('visibilitychange', onVis);
  });
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  const precision = value >= 100 || i === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[i]}`;
}
