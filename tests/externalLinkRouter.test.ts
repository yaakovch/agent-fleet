import { describe, expect, it, vi } from 'vitest';
import { routeExternalLink, type ExternalLinkRoutePlatform } from '../src/main/external-link-router';

function platform(): ExternalLinkRoutePlatform {
  return {
    applicationName: vi.fn(() => 'Mail'),
    confirm: vi.fn(async () => true),
    open: vi.fn(async () => undefined)
  };
}

describe('external link routing', () => {
  it('opens web links without confirmation', async () => {
    const adapter = platform();
    await expect(routeExternalLink('https://example.com/docs', adapter)).resolves.toMatchObject({ ok: true });
    expect(adapter.applicationName).not.toHaveBeenCalled();
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(adapter.open).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('confirms a registered non-web scheme using metadata rather than the raw URI', async () => {
    const adapter = platform();
    await expect(routeExternalLink('mailto:private@example.com?subject=secret', adapter)).resolves.toMatchObject({ ok: true });
    expect(adapter.confirm).toHaveBeenCalledWith({ scheme: 'mailto', applicationName: 'Mail' });
    expect(adapter.open).toHaveBeenCalledOnce();
  });

  it('blocks dangerous schemes before consulting or opening an application', async () => {
    const adapter = platform();
    await expect(routeExternalLink('wtmux://pair?token=secret', adapter)).resolves.toEqual({
      ok: false,
      message: 'This link type is blocked for safety.'
    });
    expect(adapter.applicationName).not.toHaveBeenCalled();
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it('requires an installed handler and treats cancellation as final', async () => {
    const missing = platform();
    missing.applicationName = vi.fn(() => '');
    await expect(routeExternalLink('web+fleet://status/healthy', missing)).resolves.toMatchObject({ ok: false });
    expect(missing.open).not.toHaveBeenCalled();

    const canceled = platform();
    canceled.confirm = vi.fn(async () => false);
    await expect(routeExternalLink('mailto:team@example.com', canceled)).resolves.toEqual({
      ok: false,
      message: 'Link opening canceled.'
    });
    expect(canceled.open).not.toHaveBeenCalled();
  });
});
