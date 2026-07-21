export type SaveRecordingResult =
  | { canceled: true }
  | { canceled: false; filePath: string };
