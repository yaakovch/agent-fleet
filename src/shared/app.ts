import type { CodexProfileSettings, SettingsImportPreview, WidgetSettings } from './settings';
import type { FleetDirectoryListing, FleetRepositoryPage } from './fleet-protocol';

export interface AppInfo {
  name: string;
  version: string;
  packaged: boolean;
  portable: boolean;
  dataDirectory: string;
  releaseUrl: string;
}

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  message?: string;
}

export interface SettingsImportSelection extends SettingsImportPreview {
  profileCount: number;
}

export interface SettingsOperationResult {
  canceled: boolean;
  message: string;
  settings?: WidgetSettings;
}

export interface FileOperationResult {
  canceled: boolean;
  message: string;
  path?: string;
}

export interface WslDistributionDiscovery {
  name: string;
  user: string;
  home: string;
  executable: string;
  codexHomes: string[];
  error?: string;
}

export interface WslDiscoveryResult {
  wslAvailable: boolean;
  distributions: WslDistributionDiscovery[];
  profiles: CodexProfileSettings[];
  warnings: string[];
}

export interface ClaudeIntegrationState {
  status: 'ready' | 'installed' | 'updated' | 'removed' | 'missing' | 'conflict';
  message: string;
}

export interface FleetDirectoryResult {
  ok: boolean;
  message: string;
  listing?: FleetDirectoryListing;
  path?: string;
}

export interface FleetRepositoryResult {
  ok: boolean;
  message: string;
  page?: FleetRepositoryPage;
}

export type FleetDownloadState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface FleetDownloadJob {
  id: string;
  sessionId: string;
  name: string;
  relativePath: string;
  state: FleetDownloadState;
  received: number;
  total: number;
  path?: string;
  message: string;
}

export interface FleetDownloadResult {
  ok: boolean;
  message: string;
  job?: FleetDownloadJob;
}
