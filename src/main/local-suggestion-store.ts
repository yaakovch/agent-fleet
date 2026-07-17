import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocalSuggestionSettingsInput, LocalSuggestionSettingsView } from '../shared/local-suggestions';
import { createDefaultLocalSuggestionSettings } from '../shared/local-suggestions';

interface StoredLocalSuggestionSettings extends Omit<LocalSuggestionSettingsView, 'external'> {
  external: Omit<LocalSuggestionSettingsView['external'], 'tokenConfigured'> & { encryptedBearerToken: string };
}

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class LocalSuggestionStore {
  private stored: StoredLocalSuggestionSettings;

  constructor(private readonly path: string, private readonly secrets: SecretCodec) {
    this.stored = this.load();
  }

  view(): LocalSuggestionSettingsView {
    return {
      version: 1,
      enabled: this.stored.enabled,
      backend: this.stored.backend,
      managed: { ...this.stored.managed },
      external: {
        baseUrl: this.stored.external.baseUrl,
        modelId: this.stored.external.modelId,
        tokenConfigured: Boolean(this.stored.external.encryptedBearerToken)
      }
    };
  }

  token(): string {
    return this.stored.external.encryptedBearerToken
      ? this.secrets.decrypt(this.stored.external.encryptedBearerToken) : '';
  }

  save(input: LocalSuggestionSettingsInput): LocalSuggestionSettingsView {
    const previousToken = this.stored.external.encryptedBearerToken;
    const encryptedBearerToken = input.external.clearToken ? ''
      : typeof input.external.bearerToken === 'string' && input.external.bearerToken
        ? this.secrets.encrypt(input.external.bearerToken) : previousToken;
    this.stored = {
      version: 1,
      enabled: Boolean(input.enabled),
      backend: input.backend === 'openAICompatible' ? 'openAICompatible' : 'managedLlamaCpp',
      managed: {
        executablePath: String(input.managed?.executablePath ?? '').trim(),
        modelPath: String(input.managed?.modelPath ?? '').trim()
      },
      external: {
        baseUrl: String(input.external?.baseUrl ?? '').trim(),
        modelId: String(input.external?.modelId ?? '').trim(),
        encryptedBearerToken
      }
    };
    this.persist();
    return this.view();
  }

  private load(): StoredLocalSuggestionSettings {
    const defaults = createDefaultLocalSuggestionSettings();
    const fallback: StoredLocalSuggestionSettings = {
      ...defaults,
      managed: { ...defaults.managed },
      external: { baseUrl: defaults.external.baseUrl, modelId: defaults.external.modelId, encryptedBearerToken: '' }
    };
    try {
      const input = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredLocalSuggestionSettings>;
      if (input.version !== 1) return fallback;
      return {
        version: 1,
        enabled: Boolean(input.enabled),
        backend: input.backend === 'openAICompatible' ? 'openAICompatible' : 'managedLlamaCpp',
        managed: {
          executablePath: typeof input.managed?.executablePath === 'string' ? input.managed.executablePath : '',
          modelPath: typeof input.managed?.modelPath === 'string' ? input.managed.modelPath : ''
        },
        external: {
          baseUrl: typeof input.external?.baseUrl === 'string' ? input.external.baseUrl : fallback.external.baseUrl,
          modelId: typeof input.external?.modelId === 'string' ? input.external.modelId : '',
          encryptedBearerToken: typeof input.external?.encryptedBearerToken === 'string' ? input.external.encryptedBearerToken : ''
        }
      };
    } catch { return fallback; }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
