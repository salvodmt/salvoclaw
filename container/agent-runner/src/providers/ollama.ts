import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';
import type { ProviderOptions } from './types.js';

class OllamaProvider extends ClaudeProvider {
  constructor(options: ProviderOptions = {}) {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || '';

    super({
      ...options,
      model: ollamaModel || options.model,
      env: {
        ...(options.env ?? {}),
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'ollama',
        NO_PROXY: 'host.docker.internal',
        no_proxy: 'host.docker.internal',
      },
    });
  }
}

registerProvider('ollama', (opts) => new OllamaProvider(opts));
