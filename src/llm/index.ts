/**
 * LLM Adapters Module
 * Central export for all LLM adapter implementations and utilities
 * Phase 3B.2 - LLM Provider Adapters
 */

export { OllamaLLMAdapter } from './adapters/ollama';
export type { LLMTool, LLMResponse } from './adapters/ollama';

export {
  ILLMAdapter,
  LLMAdapterConfig,
  ToolExecutionResult,
  TaskExecutionContext,
} from './base';

export type { ILLMAdapter };

/**
 * Factory for creating LLM adapters
 * Phase 3B.2 - Future: Gemini and Claude adapters
 */
export class LLMAdapterFactory {
  /**
   * Create LLM adapter instance based on configuration
   *
   * @param config Adapter configuration
   * @returns Configured LLM adapter instance
   *
   * @example
   * const adapter = LLMAdapterFactory.create({
   *   type: 'ollama',
   *   baseUrl: 'http://ollama:11434',
   *   model: 'mistral'
   * });
   */
  static create(config: any) {
    const { OllamaLLMAdapter } = require('./adapters/ollama');

    switch (config.type) {
      case 'ollama':
        return OllamaLLMAdapter.create(config.baseUrl, config.model);

      // Phase 3B.2 - Future implementations
      // case 'gemini':
      //   return GeminiLLMAdapter.create(config.apiKey, config.model);
      //
      // case 'claude':
      //   return ClaudeLLMAdapter.create(config.apiKey, config.model);

      default:
        throw new Error(`Unsupported LLM adapter type: ${config.type}`);
    }
  }

  /**
   * Get default LLM adapter based on environment
   * Priority: OLLAMA_BASE_URL > GEMINI_API_KEY > CLAUDE_API_KEY
   */
  static createDefault() {
    if (process.env.OLLAMA_BASE_URL) {
      return this.create({
        type: 'ollama',
        baseUrl: process.env.OLLAMA_BASE_URL,
        model: process.env.OLLAMA_MODEL,
      });
    }

    // Future: Add other adapters here based on env vars

    throw new Error(
      'No LLM adapter configured. Set OLLAMA_BASE_URL environment variable.'
    );
  }

  /**
   * Check which adapters are available based on environment
   */
  static getAvailableAdapters(): string[] {
    const available: string[] = [];

    if (process.env.OLLAMA_BASE_URL) available.push('ollama');
    if (process.env.GEMINI_API_KEY) available.push('gemini');
    if (process.env.CLAUDE_API_KEY) available.push('claude');

    return available;
  }
}

export { LLMAdapterFactory };
