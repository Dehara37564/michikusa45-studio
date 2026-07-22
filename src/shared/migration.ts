import type {
  ProjectFileV1,
  ProjectFileV2,
  ReadableProjectFile,
  ReviewData,
} from './project';
import {
  DEFAULT_CANVAS_BACKGROUND_COLOR,
  DEFAULT_CANVAS_BACKGROUND_PATTERN,
  DEFAULT_CANVAS_BACKGROUND_SPACING,
} from './project';

export const createDefaultReviewData = (): ReviewData => ({
  stampDefinitions: [
    { id: 'theme', name: 'テーマ', color: '#70c9f4', kind: 'theme', order: 0, size: 50 },
  ],
  placedStamps: [],
  visibility: { theme: true },
  displaySettings: { showFarthestPath: false },
});

export const migrateV1ToV2 = (project: ProjectFileV1): ProjectFileV2 => ({
  ...project,
  version: 2,
  canvas: {
    ...project.canvas,
    background: project.canvas.background ?? DEFAULT_CANVAS_BACKGROUND_PATTERN,
    backgroundColor: project.canvas.backgroundColor ?? DEFAULT_CANVAS_BACKGROUND_COLOR,
    backgroundSpacing: project.canvas.backgroundSpacing ?? DEFAULT_CANVAS_BACKGROUND_SPACING,
  },
  review: createDefaultReviewData(),
});

export const migrateProject = (project: ReadableProjectFile): ProjectFileV2 => {
  const version2 = project.version === 1 ? migrateV1ToV2(project) : project;
  return {
    ...version2,
    canvas: {
      ...version2.canvas,
      background: version2.canvas.background ?? DEFAULT_CANVAS_BACKGROUND_PATTERN,
      backgroundColor: version2.canvas.backgroundColor ?? DEFAULT_CANVAS_BACKGROUND_COLOR,
      backgroundSpacing: version2.canvas.backgroundSpacing ?? DEFAULT_CANVAS_BACKGROUND_SPACING,
    },
  };
};
