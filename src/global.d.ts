import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult, StartRecordingConversionResult } from './shared/recording';
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
      isFullScreen: () => Promise<boolean>;
      quit: () => Promise<void>;
      startRecordingConversion: (
        fps: 30 | 60,
        withAudio: boolean,
        outputWidth: number,
        outputHeight: number,
        mjpegQuality: 1 | 3 | 5,
        suggestedName: string,
      ) => Promise<StartRecordingConversionResult>;
      writeRecordingConversion: (id: string, bytes: Uint8Array) => Promise<void>;
      finishRecordingConversion: (id: string) => Promise<SaveRecordingResult>;
      abortRecordingConversion: (id: string) => Promise<void>;
      saveRecording: (
        bytes: Uint8Array,
        suggestedName: string,
        fps: 30 | 60,
        withAudio: boolean,
        durationMilliseconds: number,
        outputWidth: number,
        outputHeight: number,
      ) => Promise<SaveRecordingResult>;
      savePng: (
        bytes: Uint8Array,
        suggestedName: string,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    };
  }
}

export {};
