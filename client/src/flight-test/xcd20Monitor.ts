import type {TestDocument} from './model';

/** Local test oracles only. No flight-controller messages or parameter edits. */
export function xcd20ObservationKeys(document: TestDocument | null): string[] {
  if (document?.aircraft !== 'XCD20_FlightIdentified') return [];
  const rail = document.requirements?.['xcd20-takeoff'];
  if (rail !== 0 && rail !== 1) return [];
  return ['moving-platform/enabled', ...(rail === 1 ? [
    'moving-platform/contact-mode', 'moving-platform/rail/contact-mask',
    'moving-platform/rail/valid-mask', 'moving-platform/rail/released-mask',
    'moving-platform/rail/travel-m', 'moving-platform/rail/travel-m[1]',
  ] : [])];
}
