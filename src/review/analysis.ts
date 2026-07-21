import type { PlacedStamp, StampDefinition } from '../shared/project';

export type MichikusaResult =
  | { available: true; value: number; farthestStampId: string; farthestDefinitionId: string; distance: number }
  | { available: false; reason: 'theme-not-placed' | 'no-custom-stamps' };

export const countStamps = (stamps: PlacedStamp[]): Map<string, number> => {
  const counts = new Map<string, number>();
  stamps.forEach((stamp) => counts.set(stamp.definitionId, (counts.get(stamp.definitionId) ?? 0) + 1));
  return counts;
};

export const calculatePercentages = (
  definitions: StampDefinition[],
  stamps: PlacedStamp[],
): Array<{ definition: StampDefinition; count: number; percentage: number }> => {
  const counts = countStamps(stamps);
  const custom = definitions.filter((definition) => definition.kind === 'custom');
  const total = custom.reduce((sum, definition) => sum + (counts.get(definition.id) ?? 0), 0);
  return custom
    .map((definition) => ({ definition, count: counts.get(definition.id) ?? 0, percentage: total === 0 ? 0 : Math.round(((counts.get(definition.id) ?? 0) / total) * 100) }))
    .sort((a, b) => b.count - a.count || a.definition.order - b.definition.order);
};

export const calculateMichikusa = (
  definitions: StampDefinition[],
  stamps: PlacedStamp[],
): MichikusaResult => {
  const themeDefinition = definitions.find((definition) => definition.kind === 'theme');
  const theme = themeDefinition && stamps.find((stamp) => stamp.definitionId === themeDefinition.id);
  if (!theme) return { available: false, reason: 'theme-not-placed' };
  const customIds = new Set(definitions.filter((definition) => definition.kind === 'custom').map((definition) => definition.id));
  const custom = stamps.filter((stamp) => customIds.has(stamp.definitionId));
  if (custom.length === 0) return { available: false, reason: 'no-custom-stamps' };
  const ranked = custom.map((stamp) => ({ stamp, distance: Math.hypot(stamp.x - theme.x, stamp.y - theme.y) })).sort((a, b) => b.distance - a.distance || a.stamp.createdAt.localeCompare(b.stamp.createdAt));
  const farthest = ranked[0];
  const value = Math.round(((farthest.distance / 1920) * 45) * 10) / 10;
  return { available: true, value, farthestStampId: farthest.stamp.id, farthestDefinitionId: farthest.stamp.definitionId, distance: farthest.distance };
};
