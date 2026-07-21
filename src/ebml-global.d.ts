type EbmlReaderInstance = {
  logging: boolean;
  drop_default_duration: boolean;
  metadataSize: number;
  duration: number;
  metadatas: unknown[];
  cues: unknown[];
  read: (element: unknown) => void;
  stop: () => void;
};

type EbmlGlobal = {
  Decoder: new () => { decode: (buffer: ArrayBuffer) => unknown[] };
  Reader: new () => EbmlReaderInstance;
  tools: {
    makeMetadataSeekable: (
      metadata: unknown[],
      duration: number,
      cues: unknown[],
    ) => ArrayBuffer;
  };
};

declare global {
  interface Window {
    EBML?: EbmlGlobal;
  }
}

export {};
