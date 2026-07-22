export const BRUSH_DEFINITIONS = [
  { id: 'pen', label: 'ペン', widthMultiplier: 1, opacityMultiplier: 1 },
  { id: 'pencil', label: '鉛筆', widthMultiplier: 0.62, opacityMultiplier: 0.68 },
  { id: 'marker', label: 'マーカー', widthMultiplier: 1.35, opacityMultiplier: 0.48 },
  { id: 'brush', label: '筆', widthMultiplier: 1.18, opacityMultiplier: 0.94 },
] as const;

export type BrushKind = (typeof BRUSH_DEFINITIONS)[number]['id'];

export const getBrushDefinition = (kind: BrushKind | undefined) =>
  BRUSH_DEFINITIONS.find((definition) => definition.id === kind) ?? BRUSH_DEFINITIONS[0];
