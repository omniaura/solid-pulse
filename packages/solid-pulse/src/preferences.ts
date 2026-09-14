import { FEATURES, type Filters, type PulseController } from './core/controller.js';

/** Preferences only: never persist events, recordings or captured bodies. */
export function restorePreferences(controller: PulseController, key: string | false) {
  if (!key) return () => {};
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved?.version === 1) {
      for (const feature of FEATURES) {
        if (typeof saved.features?.[feature] === 'boolean') controller.setFeature(feature, saved.features[feature]);
      }
      const filters: Partial<Filters> = {};
      if (Array.isArray(saved.filters?.kinds) && saved.filters.kinds.every((v: unknown) => typeof v === 'string')) filters.kinds = saved.filters.kinds;
      for (const field of ['component', 'text'] as const) if (typeof saved.filters?.[field] === 'string') filters[field] = saved.filters[field];
      controller.setFilters(filters);
    }
  } catch { /* Invalid or denied storage must not prevent app startup. */ }
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify({ version: 1, features: controller.snapshotFeatures(), filters: controller.filters })); }
    catch { /* Storage is optional. */ }
  };
  const offFeatures = controller.onFeature(save);
  const offFilters = controller.onFilters(save);
  return () => { offFeatures(); offFilters(); };
}
