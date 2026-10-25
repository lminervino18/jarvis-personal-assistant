const REMEMBERED_CANCELLATIONS = 32;

/**
 * Decides which turn's speech may be played. Only the turn of the latest accepted
 * `audio.begin` is current; frames of any other turn, or of a turn the owner cut, are dropped.
 */
export class AudioTurnGate {
  private current: string | null = null;
  private readonly cancelled: string[] = [];

  get speakingTurn(): string | null {
    return this.current;
  }

  begin(turnId: string): boolean {
    if (this.cancelled.includes(turnId)) return false;
    this.current = turnId;
    return true;
  }

  end(turnId: string): void {
    if (this.current === turnId) this.current = null;
  }

  cancel(turnId: string): void {
    if (!this.cancelled.includes(turnId)) {
      this.cancelled.push(turnId);
      if (this.cancelled.length > REMEMBERED_CANCELLATIONS) this.cancelled.shift();
    }
    if (this.current === turnId) this.current = null;
  }

  accepts(turnId: string): boolean {
    return this.current === turnId;
  }

  reset(): void {
    this.current = null;
  }
}
