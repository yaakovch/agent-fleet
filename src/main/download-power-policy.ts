import type { FleetDownloadJob } from '../shared/app';

export interface SuspensionBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export class DownloadPowerPolicy {
  private activeJobs = new Set<string>();
  private blockerId: number | null = null;

  constructor(private readonly blocker: SuspensionBlocker) {}

  update(job: Pick<FleetDownloadJob, 'id' | 'state'>): void {
    if (job.state === 'running') this.activeJobs.add(job.id);
    else this.activeJobs.delete(job.id);
    this.sync();
  }

  dispose(): void {
    this.activeJobs.clear();
    this.sync();
  }

  status(): { activeDownloads: number; suspensionBlocked: boolean; displayBlocked: false } {
    return {
      activeDownloads: this.activeJobs.size,
      suspensionBlocked: this.blockerId !== null && this.blocker.isStarted(this.blockerId),
      displayBlocked: false
    };
  }

  private sync(): void {
    if (this.activeJobs.size && this.blockerId === null) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
    } else if (!this.activeJobs.size && this.blockerId !== null) {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
}
