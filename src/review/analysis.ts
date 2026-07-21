import type { PlacedStamp, StampDefinition } from '../shared/project';

export const SPREAD_SCALE = 1000;
export const COUNT_SCALE = 15;
export const EPSILON = 0.000001;

type Coordinate = { x: number; y: number };

export type MichikusaMetrics = {
  spreadNormalized: number;
  directionality: number;
  countNormalized: number;
  score: number;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const calculateMichikusaMetrics = (points: Coordinate[]): MichikusaMetrics => {
  const count = points.length;
  const countNormalized = 1 - Math.exp(-count / COUNT_SCALE);
  if (count < 2) {
    const score = clamp(45 * 0.2 * countNormalized, 0, 45);
    return { spreadNormalized: 0, directionality: 0, countNormalized, score };
  }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / count;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / count;
  let varX = 0;
  let varY = 0;
  let covXY = 0;
  points.forEach((point) => {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    varX += dx * dx;
    varY += dy * dy;
    covXY += dx * dy;
  });
  varX /= count;
  varY /= count;
  covXY /= count;

  const trace = varX + varY;
  const determinant = varX * varY - covXY * covXY;
  const discriminant = Math.max(0, trace * trace - 4 * determinant);
  const root = Math.sqrt(discriminant);
  const lambda1 = Math.max(0, (trace + root) / 2);
  const lambda2 = Math.max(0, (trace - root) / 2);
  const spread = Math.sqrt(lambda1 + lambda2);
  const spreadNormalized = 1 - Math.exp(-spread / SPREAD_SCALE);
  const directionality = clamp(lambda2 / (lambda1 + EPSILON), 0, 1);
  const rawScore = 0.45 * spreadNormalized + 0.35 * directionality + 0.2 * countNormalized;
  return { spreadNormalized, directionality, countNormalized, score: clamp(45 * rawScore, 0, 45) };
};

export const calculateMichikusaScore = (points: Coordinate[]): number =>
  Math.round(calculateMichikusaMetrics(points).score * 10) / 10;

export type MichikusaResult =
  | { available: true; farthestStampId: string; farthestDefinitionId: string; distance: number }
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
  return { available: true, farthestStampId: farthest.stamp.id, farthestDefinitionId: farthest.stamp.definitionId, distance: farthest.distance };
};
