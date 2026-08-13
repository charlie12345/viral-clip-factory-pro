/**
 * Shared time/timestamp formatting helpers.
 *
 * These centralize helpers that were previously duplicated across pages:
 * - `formatTime` matches the integer `m:ss` / `h:mm:ss` implementations that
 *   existed (identically) in LongformEditorPage and ProfessionalEditorTools.
 * - `formatTimecode` matches LongformEditorPage's frame-accurate HH:MM:SS:FF.
 * - `formatTimestamp` matches JobsPage's ISO-string → locale date-time helper
 *   (kept as a separate name because its input is a timestamp, not seconds).
 *
 * NOTE: a few not-yet-migrated call sites use other precisions — ShortsReviewPage
 * (`m:ss.s` tenths), LongformReviewPage (`h:mm:ss.mmm`), EditorV3Workspace
 * (`m:ss:FF` at 30fps). Those are intentionally left local to their pages until
 * the follow-up migration pass; do not "simplify" them to these helpers blindly.
 */

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. Non-finite/negative → `0:00`. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Frame-accurate SMPTE-ish timecode `HH:MM:SS:FF` for a duration in seconds. */
export function formatTimecode(seconds: number, fps = 30): string {
  const safeValue = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalFrames = Math.floor(safeValue * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

/** Format an ISO timestamp as a short locale date-time string. Falls back to the raw input. */
export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}
