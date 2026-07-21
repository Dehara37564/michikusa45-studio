import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult } from './shared/recording';

declare global {
  interface Window {
    michikusa: {
      saveProject: (
        project: ProjectFile,
        currentPath?: string,
        saveAs?: boolean,
      ) => Promise<SaveProjectResult>;
      openProject: () => Promise<OpenProjectResult>;
      saveRecording: (
        bytes: Uint8Array,
        suggestedName: string,
      ) => Promise<SaveRecordingResult>;
    };
  }
}

export {};
