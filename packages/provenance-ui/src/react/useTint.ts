import { useSyncExternalStore } from 'react';
import type { ProvenanceTint, TintSnapshot } from '../tint';

/** The tint's current snapshot, re-rendering on change. */
export function useProvenanceTint(tint: ProvenanceTint): TintSnapshot {
  return useSyncExternalStore(tint.subscribe, tint.getSnapshot, tint.getSnapshot);
}
