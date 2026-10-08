/** Parse all ordered output, reveal only after acknowledged writes and quiet dimensions. */
export class TerminalPresentation {
  private queue = '';
  private writing = false;
  private quiet?: ReturnType<typeof setTimeout>;
  private offer?: ReturnType<typeof setTimeout>;
  private sized = false;
  private seenOutput = false;
  private loading = false;
  private disposed = false;

  constructor(private readonly write: (data: string, done: () => void) => void,
    private readonly display: (loading: boolean, showLive: boolean) => void) { this.begin(); }

  begin(): void {
    if (this.disposed) return;
    clearTimeout(this.quiet);
    if (!this.loading) {
      this.loading = true;
      this.display(true, false);
      this.offer = setTimeout(() => { if (this.loading && !this.disposed) this.display(true, true); }, 2000);
    }
  }
  prepareDimensions(): void { this.sized = false; this.begin(); }
  dimensions(): void { this.sized = true; this.begin(); this.settle(); }
  output(data: string): void { this.seenOutput ||= data.length > 0; this.queue += data; clearTimeout(this.quiet); this.drain(); }
  showLive(): void { this.loading = false; clearTimeout(this.offer); this.display(false, false); }
  fail(): void { this.showLive(); }
  dispose(): void { this.disposed = true; clearTimeout(this.quiet); clearTimeout(this.offer); }

  private drain(): void {
    if (this.disposed || this.writing) return;
    if (!this.queue) { this.settle(); return; }
    let count = Math.min(this.queue.length, 64 * 1024);
    // Never divide a UTF-16 surrogate pair at the batch boundary.
    if (count < this.queue.length && /[\uD800-\uDBFF]/u.test(this.queue[count - 1])) --count;
    const data = this.queue.slice(0, count);
    this.queue = this.queue.slice(count);
    this.writing = true;
    this.write(data, () => { this.writing = false; this.drain(); });
  }
  private settle(): void {
    if (!this.loading || !this.sized || !this.seenOutput || this.queue || this.writing || this.disposed) return;
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.showLive(), 150);
  }
}
