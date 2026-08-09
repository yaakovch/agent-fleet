import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  fleetConfigurationExport,
  parseFleetPairingBundle,
  type FleetPairingBundle
} from '../shared/fleet-configuration';
import { getWidgetDataDir } from './app-paths';
import { durableAtomicWrite, readFileSnapshot, withCrossProcessLock } from './durable-file';

const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024;

export interface FleetConfigurationActivation {
  status: 'activated' | 'unchanged';
  configurationRevision: number;
  previousRevision: number;
}

export class FleetConfigurationStore {
  readonly root: string;

  constructor(root = join(getWidgetDataDir(), 'fleet-configuration')) {
    this.root = root;
  }

  current(): FleetPairingBundle | null {
    return this.locked(() => this.read('current.json'));
  }

  previous(): FleetPairingBundle | null {
    return this.locked(() => this.read('previous.json'));
  }

  review(content: string): FleetPairingBundle {
    return parseFleetPairingBundle(content);
  }

  activate(content: string): FleetConfigurationActivation {
    const candidate = parseFleetPairingBundle(content);
    return this.locked(() => {
      const current = this.read('current.json');
      if (current && candidate.configurationRevision < current.configurationRevision) {
        throw new Error('Fleet configuration is older than the last healthy revision');
      }
      if (current && candidate.configurationRevision === current.configurationRevision) {
        if (candidate.integrity.digest !== current.integrity.digest) {
          throw new Error('Fleet configuration revision was reused with different content');
        }
        return {
          status: 'unchanged',
          configurationRevision: current.configurationRevision,
          previousRevision: this.read('previous.json')?.configurationRevision ?? 0
        };
      }
      if (current) this.write('previous.json', fleetConfigurationExport(current));
      this.write('current.json', fleetConfigurationExport(candidate));
      return {
        status: 'activated',
        configurationRevision: candidate.configurationRevision,
        previousRevision: current?.configurationRevision ?? 0
      };
    });
  }

  rollback(): FleetPairingBundle {
    return this.locked(() => {
      const previous = this.read('previous.json');
      const current = this.read('current.json');
      if (!previous || !current) throw new Error('No previous healthy fleet configuration is available');
      this.write('previous.json', fleetConfigurationExport(current));
      this.write('current.json', fleetConfigurationExport(previous));
      return previous;
    });
  }

  export(): string {
    return this.locked(() => {
      const current = this.read('current.json');
      if (!current) throw new Error('No active fleet configuration is available');
      return fleetConfigurationExport(current);
    });
  }

  private read(name: string): FleetPairingBundle | null {
    const path = join(this.root, name);
    return existsSync(path)
      ? parseFleetPairingBundle(readFileSnapshot(path, MAX_CONFIGURATION_BYTES).data.toString('utf8'))
      : null;
  }

  private write(name: string, content: string): void {
    durableAtomicWrite(join(this.root, name), content, { mode: 0o600 });
  }

  private locked<Result>(task: () => Result): Result {
    return withCrossProcessLock(join(this.root, '.configuration-store'), task);
  }
}
