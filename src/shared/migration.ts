import type {
  ProjectFileV1,
  ProjectFileV2,
  ReadableProjectFile,
  ReviewData,
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
  review: createDefaultReviewData(),
});

export const migrateProject = (project: ReadableProjectFile): ProjectFileV2 =>
  project.version === 1 ? migrateV1ToV2(project) : project;
