export type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type Stroke = {
  id: string;
  color: string;
  baseWidth: number;
  brush?: import('./brushes').BrushKind;
  opacity?: number;
  points: Point[];
  layerId?: string;
};

export type LayerDefinition = {
  id: string;
  name: string;
  visible: boolean;
  order: number;
};

export type ImportedCanvasImage = { id: string; name: string; dataUrl: string; x: number; y: number; width: number; height: number; layerId?: string };

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Tool = 'pen' | 'eraser' | 'select';

export type CanvasBackgroundColor = 'white' | 'black' | 'paper';
export type CanvasBackgroundPattern = 'plain' | 'dots' | 'ruled' | 'grid';

export const DEFAULT_CANVAS_BACKGROUND_COLOR: CanvasBackgroundColor = 'white';
export const DEFAULT_CANVAS_BACKGROUND_PATTERN: CanvasBackgroundPattern = 'plain';
export const DEFAULT_CANVAS_BACKGROUND_SPACING = 32;

export type StampDefinition = {
  id: string;
  name: string;
  color: string;
  kind: 'theme' | 'custom';
  order: number;
  size?: number;
};

export type PlacedStamp = {
  id: string;
  definitionId: string;
  x: number;
  y: number;
  createdAt: string;
  recordingTimeMs?: number;
};

export type ReviewData = {
  stampDefinitions: StampDefinition[];
  placedStamps: PlacedStamp[];
  visibility: Record<string, boolean>;
  displaySettings: { showFarthestPath: boolean };
};

export type ProjectFileV1 = {
  format: 'm45';
  version: 1;
  createdAt: string;
  updatedAt: string;
  canvas: {
    background: CanvasBackgroundPattern;
    backgroundColor?: CanvasBackgroundColor;
    backgroundSpacing?: number;
    strokes: Stroke[];
    layers?: LayerDefinition[];
    activeLayerId?: string;
    importedImages?: ImportedCanvasImage[];
  };
  camera: Camera;
  settings: {
    selectedColor: string;
    selectedWidth: number;
    selectedBrush?: import('./brushes').BrushKind;
    selectedOpacity?: number;
    zoomCompensatedInputWidth?: boolean;
    drawingSettings?: Partial<Record<import('./brushes').BrushKind | 'eraser', { width: number; opacity: number; color?: string }>>;
  };
};

export type ProjectFileV2 = Omit<ProjectFileV1, 'version' | 'canvas'> & {
  version: 2;
  canvas: Omit<ProjectFileV1['canvas'], 'background' | 'backgroundColor' | 'backgroundSpacing'> & {
    background: CanvasBackgroundPattern;
    backgroundColor: CanvasBackgroundColor;
    backgroundSpacing: number;
  };
  review: ReviewData;
};

export type ProjectFile = ProjectFileV2;
export type ReadableProjectFile = ProjectFileV1 | ProjectFileV2;

export type OpenProjectResult =
  | { canceled: true }
  | { canceled: false; filePath: string; project: ProjectFile };

export type SaveProjectResult =
  | { canceled: true }
  | { canceled: false; filePath: string };
