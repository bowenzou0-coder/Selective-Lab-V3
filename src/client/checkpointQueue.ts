export interface CheckpointSaveResponse {
  checkpointRevision?: number;
  revision?: number;
  serverNowIso?: string;
}

export interface CheckpointConflictInfo<TCheckpoint> {
  currentRevision: number;
  serverCheckpoint: TCheckpoint;
}

export interface CheckpointSaveError<TCheckpoint> {
  status?: number;
  alreadySubmitted?: boolean;
  expiredAutoSubmitted?: boolean;
  currentRevision?: number;
  serverCheckpoint?: TCheckpoint;
}

export interface CheckpointQueueOptions<TCheckpoint> {
  initialRevision: number;
  getPayload: () => TCheckpoint;
  canSave: () => boolean;
  saveFn: (
    payload: TCheckpoint,
    expectedRevision: number
  ) => Promise<CheckpointSaveResponse>;
  onBeforeSave?: (payload: TCheckpoint) => void;
  onSaved?: (res: CheckpointSaveResponse, stillDirty: boolean) => void;
  onAlreadySubmitted?: () => Promise<void> | void;
  onConflict?: (conflict: CheckpointConflictInfo<TCheckpoint>) => void;
  onError?: (err: unknown) => void;
}

/**
 * Serializes checkpoint saves for a single active session so rapid clicks,
 * page navigation, and periodic autosaves never overlap with the same
 * expectedRevision and trigger false-positive 409 conflicts.
 */
export class CheckpointSaveQueue<TCheckpoint> {
  private revision: number;
  private mutationSeq = 0;
  private lastSavedSeq = 0;
  private inFlightPromise: Promise<void> | null = null;
  private pendingFlush = false;
  private pendingOverrideRevision: number | undefined = undefined;
  private hasConflict = false;
  private disposed = false;
  private readonly options: CheckpointQueueOptions<TCheckpoint>;

  constructor(options: CheckpointQueueOptions<TCheckpoint>) {
    this.options = options;
    this.revision = options.initialRevision;
  }

  getRevision(): number {
    return this.revision;
  }

  setRevision(nextRevision: number): void {
    this.revision = nextRevision;
  }

  markDirty(): void {
    this.mutationSeq += 1;
  }

  isDirty(): boolean {
    return this.mutationSeq > this.lastSavedSeq;
  }

  hasActiveConflict(): boolean {
    return this.hasConflict;
  }

  clearConflict(nextRevision?: number, markClean = false): void {
    this.hasConflict = false;
    if (typeof nextRevision === 'number') {
      this.revision = nextRevision;
    }
    if (markClean) {
      this.lastSavedSeq = this.mutationSeq;
      this.pendingFlush = false;
      this.pendingOverrideRevision = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pendingFlush = false;
    this.pendingOverrideRevision = undefined;
  }

  flush(overrideExpectedRevision?: number): Promise<void> {
    if (this.disposed || !this.options.canSave()) {
      return Promise.resolve();
    }
    if (this.hasConflict && overrideExpectedRevision === undefined) {
      return Promise.resolve();
    }

    if (this.inFlightPromise) {
      this.pendingFlush = true;
      if (overrideExpectedRevision !== undefined) {
        this.pendingOverrideRevision = overrideExpectedRevision;
      }
      return this.inFlightPromise;
    }

    const runLoop = async (initialOverride?: number) => {
      let nextOverride = initialOverride;
      try {
        while (!this.disposed && this.options.canSave()) {
          if (this.hasConflict && nextOverride === undefined) {
            break;
          }

          const seqAtSend = this.mutationSeq;
          const payload = this.options.getPayload();
          const expectedRev = nextOverride ?? this.revision;
          nextOverride = undefined;
          this.pendingFlush = false;
          this.pendingOverrideRevision = undefined;

          this.options.onBeforeSave?.(payload);

          try {
            const res = await this.options.saveFn(payload, expectedRev);
            if (this.disposed) break;

            const nextRev = res.checkpointRevision ?? res.revision ?? expectedRev + 1;
            this.revision = nextRev;
            this.hasConflict = false;
            this.lastSavedSeq = Math.max(this.lastSavedSeq, seqAtSend);

            const stillDirty = this.mutationSeq > this.lastSavedSeq;
            this.options.onSaved?.(res, stillDirty);

            if (!stillDirty && !this.pendingFlush) {
              break;
            }
            nextOverride = this.pendingOverrideRevision;
          } catch (err) {
            if (this.disposed) break;
            const apiErr = err as CheckpointSaveError<TCheckpoint>;
            if (
              apiErr?.status === 409 &&
              (apiErr.expiredAutoSubmitted || apiErr.alreadySubmitted)
            ) {
              this.lastSavedSeq = this.mutationSeq;
              this.pendingFlush = false;
              this.pendingOverrideRevision = undefined;
              await this.options.onAlreadySubmitted?.();
              break;
            }
            if (
              apiErr?.status === 409 &&
              apiErr.serverCheckpoint !== undefined &&
              typeof apiErr.currentRevision === 'number'
            ) {
              this.hasConflict = true;
              this.pendingFlush = false;
              this.pendingOverrideRevision = undefined;
              this.options.onConflict?.({
                currentRevision: apiErr.currentRevision,
                serverCheckpoint: apiErr.serverCheckpoint,
              });
              break;
            }
            this.pendingFlush = false;
            this.pendingOverrideRevision = undefined;
            this.options.onError?.(err);
            break;
          }
        }
      } finally {
        this.inFlightPromise = null;
      }
    };

    this.inFlightPromise = runLoop(overrideExpectedRevision);
    return this.inFlightPromise;
  }
}
