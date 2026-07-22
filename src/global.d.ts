import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult } from './shared/recording';
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
      openImage: () => Promise<{ canceled: true } | { canceled: false; name: string; dataUrl: string }>;
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
      ) => Promise<SaveRecordingResult>;
      savePng: (
        bytes: Uint8Array,
        suggestedName: string,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    };
  }
}

export {};
