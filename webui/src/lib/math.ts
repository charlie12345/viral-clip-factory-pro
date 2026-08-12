/**
 * Shared math helpers.
 *
 * `clamp` centralizes the implementations previously duplicated in
 * ProfessionalEditorTools and EditorV3Workspace (both guarded NaN → min).
 * LongformEditorPage's local `clampValue` lacks the NaN guard but behaves
 * identically for finite inputs; it can be migrated to this helper safely.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
