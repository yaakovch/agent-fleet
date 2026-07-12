import type { FleetSnapshot } from '../../shared/fleet';

export const FLEET_FIXTURE: FleetSnapshot = {
  revision: '1842',
  generatedAt: '2026-07-12T00:26:00.000Z',
  registrySyncedAt: '2026-07-12T00:25:43.000Z',
  controller: { distro: 'Ubuntu-24.04', status: 'healthy', protocolVersion: 1 },
  hosts: [
    {
      id: 'work-m', name: 'work-m', machine: 'Windows desktop · WSL', platform: 'wsl', status: 'healthy',
      lastSeenAt: '2026-07-12T00:25:58.000Z', timeZone: 'Asia/Jerusalem', wtmuxVersion: '1.4.0-dev',
      protocolVersion: 1, sessionCount: 3, cpuPercent: 18, memoryPercent: 42, detail: 'Live through Tailscale SSH'
    },
    {
      id: 'home-m', name: 'home-m', machine: 'Windows laptop · WSL', platform: 'wsl', status: 'attention',
      lastSeenAt: '2026-07-12T00:25:51.000Z', timeZone: 'Asia/Jerusalem', wtmuxVersion: '1.3.2',
      protocolVersion: 1, sessionCount: 2, cpuPercent: 9, memoryPercent: 61, detail: 'Runtime update available'
    },
    {
      id: 's23fe', name: 's23fe', machine: 'Samsung S23 FE · Termux', platform: 'termux', status: 'offline',
      lastSeenAt: '2026-07-11T23:44:12.000Z', timeZone: 'Asia/Jerusalem', wtmuxVersion: '1.3.2',
      protocolVersion: 1, sessionCount: 0, detail: 'Outbound client last connected 42 minutes ago'
    }
  ],
  sessions: [
    {
      id: 'work-m:wtmux', hostId: 'work-m', name: 'wtmux', title: 'Agent Fleet dashboard prototype',
      project: 'wtmux', projectPath: '/home/user/projects/wtmux', tool: 'codex', backend: 'wsl', profileAlias: 'codex2',
      activity: 'active', attached: true, updatedAt: '2026-07-12T00:25:52.000Z', pendingScheduleCount: 0, favorite: true
    },
    {
      id: 'work-m:doctor', hostId: 'work-m', name: 'doctor', title: 'Registry migration audit',
      project: 'wtmux', projectPath: '/home/user/projects/wtmux', tool: 'claude', backend: 'wsl',
      activity: 'waiting', attached: false, updatedAt: '2026-07-12T00:21:08.000Z', pendingScheduleCount: 1, favorite: false
    },
    {
      id: 'work-m:notes', hostId: 'work-m', name: 'notes', title: 'Release checklist',
      project: 'agent-fleet', projectPath: '/mnt/c/projects/agent-fleet', tool: 'shell', backend: 'wsl',
      activity: 'idle', attached: false, updatedAt: '2026-07-12T00:12:17.000Z', pendingScheduleCount: 0, favorite: false
    },
    {
      id: 'home-m:client', hostId: 'home-m', name: 'client', title: 'Limits alert recovery',
      project: 'agent-fleet', projectPath: '/mnt/c/projects/agent-fleet', tool: 'codex', backend: 'wsl', profileAlias: 'codex3',
      activity: 'waiting', attached: true, updatedAt: '2026-07-12T00:24:39.000Z', pendingScheduleCount: 1, favorite: true
    },
    {
      id: 'home-m:docs', hostId: 'home-m', name: 'docs', title: 'Pairing threat model',
      project: 'wtmux', projectPath: '/home/user/projects/wtmux', tool: 'copilot', backend: 'linux',
      activity: 'idle', attached: false, updatedAt: '2026-07-11T23:58:01.000Z', pendingScheduleCount: 0, favorite: false
    }
  ],
  schedules: [
    {
      id: 'schedule-1', sessionId: 'work-m:doctor', hostId: 'work-m', summary: 'continue',
      deliverAt: '2026-07-12T02:05:00.000Z', hostTimeZone: 'Asia/Jerusalem', status: 'pending', createdAt: '2026-07-12T00:05:18.000Z'
    },
    {
      id: 'schedule-2', sessionId: 'home-m:client', hostId: 'home-m', summary: 'continue with the updater rollback test',
      deliverAt: '2026-07-12T03:30:00.000Z', hostTimeZone: 'Asia/Jerusalem', status: 'pending', createdAt: '2026-07-11T23:48:00.000Z'
    },
    {
      id: 'schedule-3', sessionId: 'work-m:wtmux', hostId: 'work-m', summary: 'continue',
      deliverAt: '2026-07-11T19:05:00.000Z', hostTimeZone: 'Asia/Jerusalem', status: 'delivered',
      createdAt: '2026-07-11T17:12:00.000Z', completedAt: '2026-07-11T19:05:01.000Z', detail: 'Delivered once to the guarded Codex process'
    },
    {
      id: 'schedule-4', sessionId: 'home-m:old', hostId: 'home-m', summary: 'continue',
      deliverAt: '2026-07-10T05:20:00.000Z', hostTimeZone: 'Asia/Jerusalem', status: 'interrupted',
      createdAt: '2026-07-10T01:02:00.000Z', completedAt: '2026-07-10T05:20:00.000Z', detail: 'Guarded process changed after host restart'
    }
  ],
  attention: [
    {
      id: 'attention-1', severity: 'failure', kind: 'hard-limit', title: 'codex3 reached its 5-hour limit',
      detail: 'home-m · client · available again at 05:05 local time', hostId: 'home-m', createdAt: '2026-07-12T00:24:41.000Z',
      actionLabel: 'Open session', resolutionScope: 'fleet'
    },
    {
      id: 'attention-2', severity: 'attention', kind: 'version', title: 'home-m runtime is behind',
      detail: 'Installed 1.3.2 · controller offers 1.4.0-dev', hostId: 'home-m', createdAt: '2026-07-12T00:20:00.000Z',
      actionLabel: 'Review update', resolutionScope: 'fleet'
    },
    {
      id: 'attention-3', severity: 'offline', kind: 'host', title: 's23fe is offline',
      detail: 'Last outbound connection 42 minutes ago', hostId: 's23fe', createdAt: '2026-07-11T23:44:22.000Z',
      actionLabel: 'Acknowledge', resolutionScope: 'local'
    }
  ],
  favorites: [
    { id: 'favorite-1', name: 'wtmux · Codex 2', hostId: 'work-m', project: 'wtmux', backend: 'wsl', tool: 'codex', profileAlias: 'codex2' },
    { id: 'favorite-2', name: 'Agent Fleet · Claude', hostId: 'home-m', project: 'agent-fleet', backend: 'wsl', tool: 'claude' }
  ],
  events: [
    { id: 'event-1', kind: 'limit', title: 'Hard limit detected', detail: 'home-m · codex3', occurredAt: '2026-07-12T00:24:41.000Z', severity: 'failure' },
    { id: 'event-2', kind: 'session', title: 'Session attached', detail: 'work-m · wtmux', occurredAt: '2026-07-12T00:18:12.000Z', severity: 'healthy' },
    { id: 'event-3', kind: 'schedule', title: 'Message delivered', detail: 'work-m · wtmux · once', occurredAt: '2026-07-11T19:05:01.000Z', severity: 'healthy' },
    { id: 'event-4', kind: 'host', title: 'Host disconnected', detail: 's23fe · three missed heartbeats', occurredAt: '2026-07-11T23:44:22.000Z', severity: 'offline' },
    { id: 'event-5', kind: 'pairing', title: 'Pairing invitation created', detail: 'Expires after ten minutes', occurredAt: '2026-07-11T18:22:00.000Z', severity: 'attention' }
  ],
  pairingRequests: [
    {
      id: 'pair-1', deviceName: 'surface-go', platform: 'Windows 11 · WSL', peer: 'surface-go.tailnet.ts.net',
      requestedAt: '2026-07-12T00:23:00.000Z', expiresAt: '2026-07-12T00:33:00.000Z', status: 'awaiting-review'
    }
  ],
  limits: [
    { id: 'codex2', label: 'Codex 2', fiveHourRemaining: 68, weeklyRemaining: 42, resetsAt: '2026-07-12T03:18:00.000Z', status: 'ok' },
    { id: 'codex3', label: 'Codex 3', fiveHourRemaining: 0, weeklyRemaining: 76, resetsAt: '2026-07-12T02:05:00.000Z', status: 'ok' },
    { id: 'claude', label: 'Claude Code', fiveHourRemaining: 54, weeklyRemaining: null, resetsAt: null, status: 'stale' }
  ]
};
