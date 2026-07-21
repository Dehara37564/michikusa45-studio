export type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type Stroke = {
  id: string;
  color: string;
  baseWidth: number;
  points: Point[];
  layerId?: string;
};

export type LayerDefinition = {
  id: string;
  name: string;
  visible: boolean;
  order: number;
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Tool = 'pen' | 'eraser';

export type CanvasBackgroundColor = 'white' | 'black' | 'paper';
export type CanvasBackgroundPattern = 'plain' | 'dots' | 'ruled' | 'grid';

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
  };
  camera: Camera;
  settings: {
    selectedColor: string;
    selectedWidth: number;
  };
};

export type ProjectFileV2 = Omit<ProjectFileV1, 'version'> & {
  version: 2;
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
