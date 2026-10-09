declare module 'smart-whisper' {
  export class Whisper {
    constructor(model: string, options?: { gpu?: boolean });
    transcribe(audio: Float32Array, options?: { language?: string }): Promise<{ result: Promise<unknown> }>;
    free(): Promise<void>;
  }
}
