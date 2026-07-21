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
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Tool = 'pen' | 'eraser';

export type ProjectFileV1 = {
  format: 'm45';
  version: 1;
  createdAt: string;
  updatedAt: string;
  canvas: {
    background: 'plain';
    strokes: Stroke[];
  };
  camera: Camera;
  settings: {
    selectedColor: string;
    selectedWidth: number;
  };
};

export type ProjectFile = ProjectFileV1;

export type OpenProjectResult =
  | { canceled: true }
  | { canceled: false; filePath: string; project: ProjectFile };

export type SaveProjectResult =
  | { canceled: true }
  | { canceled: false; filePath: string };
