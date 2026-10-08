/** Owns Fleet's Linux demand only; never shuts down WSL or another application's work. */
export class LinuxDemand {
  private foreground = false;
  private background = false;
  private leases = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private starting: Promise<void> = Promise.resolve();
  private inFlight = false;
  active = false;

  constructor(private readonly options: { start(): Promise<void>; stop(): void; error?(error: unknown): void }) {}

  setForeground(value: boolean): void { this.foreground = value; this.update(); }
  setBackground(value: boolean): void { this.background = value; this.update(); }
  acquire(): () => void {
    ++this.leases;
    this.update();
    let released = false;
    return () => { if (!released) { released = true; --this.leases; this.update(); } };
  }
  ready(): Promise<void> { return this.starting; }

  private update(): void {
    if (this.foreground || this.background || this.leases) {
      clearTimeout(this.timer); this.timer = undefined;
      if (this.active) return;
      this.active = true;
      if (this.inFlight) return;
      this.inFlight = true;
      const generation = ++this.generation;
      this.starting = this.options.start().catch(error => this.options.error?.(error)).then(() => {
        this.inFlight = false;
        if (generation !== this.generation && !this.active) this.options.stop();
      });
    } else if (this.active && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.active = false;
        ++this.generation;
        this.options.stop();
      }, 2000);
      this.timer.unref?.();
    }
  }
}
