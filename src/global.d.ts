import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type {
  RecordingExportSettings,
  SaveRecordingResult,
} from './shared/recording';
import type { MenuCommand, MenuPreset } from './shared/menu';

declare global {
  interface Window {
    michikusa: {
      saveProject: (
        project: ProjectFile,
        currentPath?: string,
        saveAs?: boolean,
      ) => Promise<SaveProjectResult>;
      openProject: () => Promise<OpenProjectResult>;
      onMenuCommand: (
        callback: (command: MenuCommand) => void,
      ) => () => void;
      addMenuPreset: (preset: MenuPreset) => Promise<void>;
      getMenuPresets: () => Promise<{ colors: string[]; widths: number[] }>;
      removeMenuPreset: (preset: MenuPreset) => Promise<void>;
      setFullScreen: (fullScreen: boolean) => Promise<void>;
      quit: () => Promise<void>;
      saveRecording: (
        bytes: Uint8Array,
        suggestedName: string,
        settings: RecordingExportSettings,
      ) => Promise<SaveRecordingResult>;
    };
  }
}

export {};
