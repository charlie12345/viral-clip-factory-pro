import {
  api,
  ApiError,
  type ActionCompilationOptions,
  type ActionCompilationQueued,
  type ActionCompilationUploadFile,
  type ActionCompilationUploadSession,
  type ActionCompilationUploadSessionResponse,
  type FinalizedActionCompilationUploadSession,
} from './client';

const STORAGE_KEY = 'vcf_action_compilation_upload_v1';
const STORAGE_VERSION = 2;
const MAX_CHUNK_ATTEMPTS = 4;
const CHUNK_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_TIMEOUT_MS = 60 * 1000;
const CONTROL_TIMEOUT_MS = 2 * 60 * 1000;
const CONTENT_SAMPLE_BYTES = 64 * 1024;

interface StoredCompilationUpload {
  version: number;
  fingerprint: string;
  sessionId: string;
  expiresAt: string;
  files: ActionCompilationUploadFile[];
  fileSignatures: string[];
  options: ActionCompilationOptions;
}

interface PreparedCompilationFile {
  file: File;
  metadata: ActionCompilationUploadFile;
  signature: string;
}

export type CompilationUploadPhase = 'preparing' | 'uploading' | 'retrying' | 'finalizing';

export interface CompilationUploadProgress {
  phase: CompilationUploadPhase;
  finalized: boolean;
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  completedFiles: number;
  totalFiles: number;
  currentFileIndex: number;
  currentFileName: string | null;
  currentFileUploadedBytes: number;
  currentFileTotalBytes: number;
  message: string;
}

export interface UploadActionCompilationInput {
  files: File[];
  options: ActionCompilationOptions;
  signal: AbortSignal;
  onProgress?: (progress: CompilationUploadProgress) => void;
  onSession?: (session: ActionCompilationUploadSession) => void;
  onFilesOrdered?: (files: File[]) => void;
}

export type RestoredActionCompilationUpload =
  | {
    kind: 'queued';
    result: ActionCompilationQueued;
    options: ActionCompilationOptions;
    orderedFiles: File[];
  }
  | {
    kind: 'upload';
    sessionId: string;
    options: ActionCompilationOptions;
    orderedFiles: File[];
    progress: CompilationUploadProgress;
  };

export interface CompletedActionCompilationUpload {
  queued: ActionCompilationQueued;
  options: ActionCompilationOptions;
}

export class CompilationUploadPausedError extends Error {
  constructor() {
    super('Upload paused. Your completed chunks are saved and can be resumed.');
    this.name = 'CompilationUploadPausedError';
  }
}

function metadataFor(file: File): ActionCompilationUploadFile {
  // Match the server's path.basename(...).trim().slice(...) normalization so
  // camera filenames at the boundary still reconcile with the saved session.
  const pathParts = file.name.split('/');
  const name = (pathParts[pathParts.length - 1] || '').trim().slice(0, 220);
  return {
    name,
    size: file.size,
    type: (file.type || 'application/octet-stream').slice(0, 160),
    lastModified: file.lastModified,
  };
}

function loadStoredUpload(): StoredCompilationUpload | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as StoredCompilationUpload | null;
    if (
      !parsed
      || parsed.version !== STORAGE_VERSION
      || typeof parsed.fingerprint !== 'string'
      || typeof parsed.sessionId !== 'string'
      || !Array.isArray(parsed.files)
      || !Array.isArray(parsed.fileSignatures)
      || parsed.fileSignatures.length !== parsed.files.length
      || !parsed.options
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredUpload(value: StoredCompilationUpload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Uploading still works if browser storage is unavailable; only reload
    // recovery is lost.
  }
}

export function clearStoredCompilationUpload(sessionId?: string) {
  try {
    const stored = loadStoredUpload();
    if (!sessionId || !stored || stored.sessionId === sessionId) {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore unavailable browser storage.
  }
}

function equalFileMetadata(left: ActionCompilationUploadFile[], right: ActionCompilationUploadFile[]) {
  return left.length === right.length && left.every((file, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && file.name === candidate.name
      && file.size === candidate.size
      && file.lastModified === candidate.lastModified;
  });
}

function fallbackHashBytes(value: Uint8Array) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value[index];
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

async function digestBytes(value: Uint8Array) {
  try {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return fallbackHashBytes(value);
  }
}

async function sampledFileSignature(file: File) {
  const sampleSize = Math.min(CONTENT_SAMPLE_BYTES, file.size);
  const starts = Array.from(new Set([
    0,
    Math.max(0, Math.floor((file.size - sampleSize) / 2)),
    Math.max(0, file.size - sampleSize),
  ]));
  const samples: string[] = [];
  for (const start of starts) {
    const bytes = new Uint8Array(await file.slice(start, start + sampleSize).arrayBuffer());
    samples.push(`${start}:${bytes.byteLength}:${await digestBytes(bytes)}`);
  }
  return digestBytes(new TextEncoder().encode(samples.join('|')));
}

async function prepareFiles(files: File[]) {
  const prepared: PreparedCompilationFile[] = [];
  // Keep memory flat even for multi-gigabyte sources: each source contributes
  // at most three 64 KiB samples and is released before the next is inspected.
  for (const file of files) {
    prepared.push({ file, metadata: metadataFor(file), signature: await sampledFileSignature(file) });
  }
  return prepared;
}

function preparedIdentity(metadata: ActionCompilationUploadFile, signature: string) {
  return JSON.stringify({
    name: metadata.name,
    size: metadata.size,
    lastModified: metadata.lastModified,
    signature,
  });
}

function reorderLikeStored(
  prepared: PreparedCompilationFile[],
  stored: StoredCompilationUpload,
) {
  if (prepared.length !== stored.files.length) return null;
  const available = new Map<string, PreparedCompilationFile[]>();
  for (const item of prepared) {
    const key = preparedIdentity(item.metadata, item.signature);
    const bucket = available.get(key) || [];
    bucket.push(item);
    available.set(key, bucket);
  }

  const ordered: PreparedCompilationFile[] = [];
  for (let index = 0; index < stored.files.length; index += 1) {
    const key = preparedIdentity(stored.files[index], stored.fileSignatures[index]);
    const match = available.get(key)?.shift();
    if (!match) return null;
    ordered.push(match);
  }
  return ordered;
}

async function compilationFingerprint(files: PreparedCompilationFile[]) {
  const identity = JSON.stringify(files.map(({ metadata, signature }) => ({
    name: metadata.name,
    size: metadata.size,
    lastModified: metadata.lastModified,
    signature,
  })));
  return digestBytes(new TextEncoder().encode(identity));
}

function throwIfPaused(signal: AbortSignal) {
  if (signal.aborted) throw new CompilationUploadPausedError();
}

function isFinalizedSession(
  session: ActionCompilationUploadSessionResponse,
): session is FinalizedActionCompilationUploadSession {
  return session.status === 'queued'
    && 'result' in session
    && session.finalized === true
    && session.result?.status === 'queued';
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new CompilationUploadPausedError());
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new CompilationUploadPausedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function timedRequestSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timer);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

function sessionUploadedBytes(session: ActionCompilationUploadSession) {
  return session.files.reduce(
    (sum, source) => sum + Math.min(Math.max(0, source.receivedBytes), source.size),
    0,
  );
}

function progressForSession(
  session: ActionCompilationUploadSession,
  message = 'Saved upload found — ready to resume',
): CompilationUploadProgress {
  const currentFileIndex = session.files.findIndex((source) => !source.complete && source.receivedBytes < source.size);
  const current = currentFileIndex >= 0 ? session.files[currentFileIndex] : null;
  return {
    phase: 'preparing',
    finalized: Boolean(session.finalized),
    uploadedBytes: sessionUploadedBytes(session),
    totalBytes: session.totalBytes,
    bytesPerSecond: 0,
    completedFiles: session.files.filter((source) => source.complete || source.receivedBytes >= source.size).length,
    totalFiles: session.files.length,
    currentFileIndex,
    currentFileName: current?.name || null,
    currentFileUploadedBytes: current?.receivedBytes || 0,
    currentFileTotalBytes: current?.size || 0,
    message,
  };
}

function sourceAt(session: ActionCompilationUploadSession, index: number, file: File) {
  const source = session.files[index];
  const metadata = metadataFor(file);
  if (
    !source
    || source.name !== metadata.name
    || source.size !== metadata.size
    || (source.lastModified !== null && source.lastModified !== metadata.lastModified)
  ) {
    throw new Error(`The saved upload no longer matches ${file.name}. Discard its saved progress and start again.`);
  }
  return source;
}

async function initializeSession(
  files: File[],
  options: ActionCompilationOptions,
  fingerprint: string,
  stored: StoredCompilationUpload | null,
  signal?: AbortSignal,
) {
  const metadata = files.map(metadataFor);
  const request = {
    ...(stored ? { sessionId: stored.sessionId } : {}),
    fingerprint,
    options: stored?.options || options,
    files: metadata,
  };
  try {
    return await api.createActionCompilationUploadSession(request, signal);
  } catch (error) {
    if (!stored || !(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error;
    clearStoredCompilationUpload(stored.sessionId);
    return api.createActionCompilationUploadSession({ fingerprint, options, files: metadata }, signal);
  }
}

export async function restoreActionCompilationUpload(
  files: File[],
): Promise<RestoredActionCompilationUpload | null> {
  if (files.length === 0) return null;
  const stored = loadStoredUpload();
  if (!stored) return null;
  const selected = await prepareFiles(files);
  const ordered = reorderLikeStored(selected, stored);
  if (!ordered) return null;
  const metadata = ordered.map((item) => item.metadata);
  const orderedFiles = ordered.map((item) => item.file);
  const fingerprint = await compilationFingerprint(ordered);
  if (
    stored.fingerprint !== fingerprint
    || !equalFileMetadata(stored.files, metadata)
  ) return null;

  try {
    const response = await api.actionCompilationUploadSessionStatus(stored.sessionId);
    if (isFinalizedSession(response)) {
      clearStoredCompilationUpload(response.sessionId);
      return { kind: 'queued', result: response.result, options: stored.options, orderedFiles };
    }
    saveStoredUpload({ ...stored, expiresAt: response.expiresAt, options: response.options });
    return {
      kind: 'upload',
      sessionId: response.sessionId,
      options: response.options,
      orderedFiles,
      progress: progressForSession(response),
    };
  } catch (error) {
    if (error instanceof ApiError && [404, 410].includes(error.status)) {
      clearStoredCompilationUpload(stored.sessionId);
      return null;
    }
    const totalBytes = metadata.reduce((sum, file) => sum + file.size, 0);
    return {
      kind: 'upload',
      sessionId: stored.sessionId,
      options: stored.options,
      orderedFiles,
      progress: {
        phase: 'preparing',
        finalized: false,
        uploadedBytes: 0,
        totalBytes,
        bytesPerSecond: 0,
        completedFiles: 0,
        totalFiles: metadata.length,
        currentFileIndex: 0,
        currentFileName: metadata[0]?.name || null,
        currentFileUploadedBytes: 0,
        currentFileTotalBytes: metadata[0]?.size || 0,
        message: 'Saved upload found — server status will be checked when you resume',
      },
    };
  }
}

export async function uploadActionCompilation({
  files,
  options,
  signal,
  onProgress,
  onSession,
  onFilesOrdered,
}: UploadActionCompilationInput): Promise<CompletedActionCompilationUpload> {
  if (files.length === 0) throw new Error('Choose at least one source video');
  throwIfPaused(signal);

  const saved = loadStoredUpload();
  const selected = await prepareFiles(files);
  throwIfPaused(signal);
  const ordered = saved ? (reorderLikeStored(selected, saved) || selected) : selected;
  const orderedFiles = ordered.map((item) => item.file);
  const metadata = ordered.map((item) => item.metadata);
  const fileSignatures = ordered.map((item) => item.signature);
  const fingerprint = await compilationFingerprint(ordered);
  throwIfPaused(signal);
  const reusable = saved
    && saved.fingerprint === fingerprint
    && equalFileMetadata(saved.files, metadata)
    ? saved
    : null;
  onFilesOrdered?.(orderedFiles);

  const initializeRequest = timedRequestSignal(signal, CONTROL_TIMEOUT_MS);
  let initialized: ActionCompilationUploadSessionResponse;
  try {
    initialized = await initializeSession(orderedFiles, options, fingerprint, reusable, initializeRequest.signal);
  } catch (error) {
    if (signal.aborted) throw new CompilationUploadPausedError();
    throw error;
  } finally {
    initializeRequest.cleanup();
  }
  if (isFinalizedSession(initialized)) {
    clearStoredCompilationUpload(initialized.sessionId);
    return { queued: initialized.result, options: reusable?.options || options };
  }
  let session = initialized;
  onSession?.(session);
  if (session.files.length !== orderedFiles.length) {
    throw new Error('The upload server returned an incomplete source list. Discard the session and try again.');
  }
  saveStoredUpload({
    version: STORAGE_VERSION,
    fingerprint,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    files: metadata,
    fileSignatures,
    options: session.options,
  });

  const totalBytes = orderedFiles.reduce((sum, file) => sum + file.size, 0);
  const initiallyUploadedBytes = Math.min(totalBytes, sessionUploadedBytes(session));
  let lastReportedBytes = initiallyUploadedBytes;
  let sampledBytes = initiallyUploadedBytes;
  let sampledAt = performance.now();
  let bytesPerSecond = 0;

  const report = (
    phase: CompilationUploadPhase,
    fileIndex: number,
    message: string,
  ) => {
    const actualBytes = sessionUploadedBytes(session);
    const uploadedBytes = Math.min(totalBytes, Math.max(lastReportedBytes, actualBytes));
    const now = performance.now();
    const deltaBytes = uploadedBytes - sampledBytes;
    const deltaSeconds = (now - sampledAt) / 1000;
    if (deltaBytes > 0 && deltaSeconds > 0) {
      bytesPerSecond = deltaBytes / deltaSeconds;
      sampledBytes = uploadedBytes;
      sampledAt = now;
    }
    lastReportedBytes = uploadedBytes;
    const source = fileIndex >= 0 ? sourceAt(session, fileIndex, orderedFiles[fileIndex]) : null;
    onProgress?.({
      phase,
      finalized: Boolean(session.finalized),
      uploadedBytes,
      totalBytes,
      bytesPerSecond,
      completedFiles: session.files.filter((item) => item.complete || item.receivedBytes >= item.size).length,
      totalFiles: orderedFiles.length,
      currentFileIndex: fileIndex,
      currentFileName: source?.name || null,
      currentFileUploadedBytes: source ? Math.min(source.receivedBytes, source.size) : 0,
      currentFileTotalBytes: source?.size || 0,
      message,
    });
  };

  report('preparing', -1, reusable ? 'Checking saved upload progress…' : 'Preparing resumable upload…');

  for (let fileIndex = 0; fileIndex < orderedFiles.length; fileIndex += 1) {
    const file = orderedFiles[fileIndex];
    let source = sourceAt(session, fileIndex, file);
    let offset = Math.min(Math.max(0, source.receivedBytes), file.size);
    if (source.complete || offset >= file.size) {
      report('uploading', fileIndex, `${file.name} is already uploaded`);
      continue;
    }

    while (offset < file.size) {
      throwIfPaused(signal);
      const chunkSize = Math.max(1, session.chunkSize);
      const chunkEnd = Math.min(file.size, offset + chunkSize);
      const chunk = file.slice(offset, chunkEnd);
      let committed = false;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS && !committed; attempt += 1) {
        throwIfPaused(signal);
        report(
          attempt === 0 ? 'uploading' : 'retrying',
          fileIndex,
          attempt === 0
            ? `Uploading ${file.name}`
            : `Connection interrupted — retrying ${file.name} (${attempt + 1}/${MAX_CHUNK_ATTEMPTS})`,
        );
        const requestSignal = timedRequestSignal(signal, CHUNK_TIMEOUT_MS);
        try {
          session = await api.uploadActionCompilationSourceChunk(
            session.sessionId,
            source.sourceId,
            chunk,
            offset,
            file.size,
            requestSignal.signal,
          );
          source = sourceAt(session, fileIndex, file);
          const acknowledged = Math.min(Math.max(0, source.receivedBytes), file.size);
          if (acknowledged <= offset) {
            throw new Error(`The server did not acknowledge the uploaded chunk for ${file.name}`);
          }
          offset = acknowledged;
          committed = true;
          report('uploading', fileIndex, `Uploading ${file.name}`);
        } catch (error) {
          if (signal.aborted) throw new CompilationUploadPausedError();
          lastError = error;

          const statusSignal = timedRequestSignal(signal, STATUS_TIMEOUT_MS);
          try {
            const refreshed = await api.actionCompilationUploadSessionStatus(session.sessionId, statusSignal.signal);
            if (isFinalizedSession(refreshed)) {
              clearStoredCompilationUpload(refreshed.sessionId);
              return { queued: refreshed.result, options: session.options };
            }
            session = refreshed;
            source = sourceAt(session, fileIndex, file);
            const serverOffset = Math.min(Math.max(0, source.receivedBytes), file.size);
            if (serverOffset !== offset) {
              offset = serverOffset;
              report('retrying', fileIndex, `Resuming ${file.name} from the last saved chunk…`);
              // Re-slice from the server-confirmed byte on the next outer
              // iteration. Reusing the old Blob with a new range would shift
              // its bytes and corrupt a partially received chunk.
              committed = true;
            }
          } catch (statusError) {
            if (signal.aborted) throw new CompilationUploadPausedError();
            lastError = statusError;
          } finally {
            statusSignal.cleanup();
          }

          if (committed) break;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409) {
            throw error;
          }
          if (attempt + 1 < MAX_CHUNK_ATTEMPTS) {
            await wait(750 * (2 ** attempt), signal);
          }
        } finally {
          requestSignal.cleanup();
        }
      }

      if (!committed) {
        throw lastError instanceof Error ? lastError : new Error(`Could not upload ${file.name}`);
      }
    }
  }

  throwIfPaused(signal);
  report('finalizing', -1, 'All videos uploaded — starting the montage…');
  const completeRequest = timedRequestSignal(signal, CONTROL_TIMEOUT_MS);
  let queued: ActionCompilationQueued;
  try {
    queued = await api.completeActionCompilationUploadSession(session.sessionId, completeRequest.signal);
  } catch (error) {
    if (signal.aborted) throw new CompilationUploadPausedError();
    if (completeRequest.signal.aborted) {
      throw new Error('The final response timed out. Resume the saved upload to check whether the montage was queued.');
    }
    throw error;
  } finally {
    completeRequest.cleanup();
  }
  clearStoredCompilationUpload(session.sessionId);
  return { queued, options: session.options };
}

export async function discardActionCompilationUpload(sessionId: string) {
  try {
    await api.discardActionCompilationUploadSession(sessionId);
  } catch (error) {
    if (!(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error;

    let status: ActionCompilationUploadSessionResponse;
    try {
      status = await api.actionCompilationUploadSessionStatus(sessionId);
    } catch (statusError) {
      if (statusError instanceof ApiError && [404, 410].includes(statusError.status)) {
        // The incoming session really expired or was cleaned elsewhere. There
        // is no remote data left to discard, so forgetting the local pointer is
        // the correct successful no-op.
        clearStoredCompilationUpload(sessionId);
        return;
      }
      throw statusError;
    }

    if (isFinalizedSession(status)) {
      throw new Error('This montage is already queued. Resume it to recover the job status.');
    }
    if (status.finalized) {
      throw new Error('These sources are already finalized. Resume to queue or recover the montage.');
    }
    throw error;
  }
  clearStoredCompilationUpload(sessionId);
}
