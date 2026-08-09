import { classifyExternalLink } from '../shared/external-link';

export interface ExternalLinkRoutePlatform {
  applicationName(url: string): string;
  confirm(details: { scheme: string; applicationName: string }): Promise<boolean>;
  open(url: string): Promise<void>;
}

export interface ExternalLinkRouteResult {
  ok: boolean;
  message: string;
}

/** Revalidates and routes a content-provided URI without returning or logging it. */
export async function routeExternalLink(
  value: unknown,
  platform: ExternalLinkRoutePlatform
): Promise<ExternalLinkRouteResult> {
  const target = classifyExternalLink(value);
  if (target.decision === 'block') return { ok: false, message: 'This link type is blocked for safety.' };

  if (target.decision === 'confirm') {
    let applicationName = '';
    try {
      applicationName = platform.applicationName(target.url).trim();
    } catch {
      return { ok: false, message: 'No application is registered for this link type.' };
    }
    if (!applicationName) return { ok: false, message: 'No application is registered for this link type.' };
    const safeApplicationName = applicationName.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(applicationName)
      ? applicationName : 'the registered application';
    let confirmed = false;
    try {
      confirmed = await platform.confirm({ scheme: target.scheme, applicationName: safeApplicationName });
    } catch {
      return { ok: false, message: 'The link confirmation could not be shown.' };
    }
    if (!confirmed) {
      return { ok: false, message: 'Link opening canceled.' };
    }
  }

  try {
    await platform.open(target.url);
    return { ok: true, message: 'Link opened in another application.' };
  } catch {
    return { ok: false, message: 'The external application could not open this link.' };
  }
}
