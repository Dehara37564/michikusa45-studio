export type SaveRecordingResult =
  | { canceled: true }
  | { canceled: false; filePath: string };

export type StartRecordingConversionResult =
  | { canceled: true }
  | { canceled: false; id: string; filePath: string };
