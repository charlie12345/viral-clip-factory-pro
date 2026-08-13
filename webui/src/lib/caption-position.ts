export const CAPTION_POSITION_PRECISION = 6;
export const CAPTION_CENTER_GUIDE_THRESHOLD = 0.02;

export interface CaptionSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const PRECISION_FACTOR = 10 ** CAPTION_POSITION_PRECISION;

export function clampCaptionValue(value: number, min: number, max: number) {
  const finiteValue = Number.isFinite(value) ? value : min;
  const clamped = Math.max(min, Math.min(max, finiteValue));
  return Math.round(clamped * PRECISION_FACTOR) / PRECISION_FACTOR;
}

export function clampCaptionX(value: number, width: number) {
  const safeWidth = clampCaptionValue(width, 0.15, 1);
  const halfWidth = safeWidth / 2;
  return clampCaptionValue(value, halfWidth, 1 - halfWidth);
}

export function isNearFrameCenter(value: number) {
  return Math.abs(value - 0.5) <= CAPTION_CENTER_GUIDE_THRESHOLD;
}

export function snapCaptionToFrameCenter(value: number) {
  return isNearFrameCenter(value) ? 0.5 : value;
}

export function normalizeCaptionSafeArea(value: Partial<CaptionSafeArea> | null | undefined): CaptionSafeArea | null {
  if (!value || typeof value !== 'object') return null;
  const keys: Array<keyof CaptionSafeArea> = ['top', 'right', 'bottom', 'left'];
  if (keys.some((key) => !Number.isFinite(value[key]))) return null;
  const safeArea: CaptionSafeArea = {
    top: clampCaptionValue(Number(value.top), 0, 0.45),
    right: clampCaptionValue(Number(value.right), 0, 0.45),
    bottom: clampCaptionValue(Number(value.bottom), 0, 0.45),
    left: clampCaptionValue(Number(value.left), 0, 0.45),
  };
  if (safeArea.top + safeArea.bottom >= 0.95 || safeArea.left + safeArea.right >= 0.95) return null;
  return safeArea;
}

export function isCaptionWithinSafeArea(
  x: number,
  y: number,
  width: number,
  halfHeight: number,
  safeArea: CaptionSafeArea | null | undefined,
) {
  if (!safeArea) return true;
  const halfWidth = clampCaptionValue(width, 0.15, 1) / 2;
  return (
    x - halfWidth >= safeArea.left &&
    x + halfWidth <= 1 - safeArea.right &&
    y - halfHeight >= safeArea.top &&
    y + halfHeight <= 1 - safeArea.bottom
  );
}

export function normalizedToPercent(value: number) {
  return (value * 100).toFixed(2);
}
