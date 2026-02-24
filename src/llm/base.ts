/**
 * Base LLM Adapter Interface
 * All LLM adapters (Ollama, Gemini, Claude) implement this interface
 * Phase 3B.2 - LLM Provider Adapters
 */

/**
 * Tool definition for LLM tool-calling
 */
export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * LLM Response from completion
 */
export interface LLMResponse {
  content: string;
  stop_reason?: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Base interface for LLM adapters
 * Implemented by: OllamaLLMAdapter, GeminiLLMAdapter, ClaudeLLMAdapter
 */
export interface ILLMAdapter {
  /** Adapter name (ollama, gemini, claude) */
  name: string;

  /** Whether this adapter supports streaming */
  supportsStreaming: boolean;

  /** Whether this adapter supports tool calling */
  supportsToolCalling: boolean;

  /**
   * Check if adapter is properly configured
   */
  isConfigured(): Promise<boolean>;

  /**
   * List available models
   */
  listModels(): Promise<string[]>;

  /**
   * Generate completion from prompt
   * Primary method for task execution
   */
  generateCompletion(
    prompt: string,
    tools?: LLMTool[],
    model?: string,
    options?: {
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    }
  ): Promise<LLMResponse>;

  /**
   * Simple text generation from prompt
   * Legacy method for non-chat use cases
   */
  generate(
    prompt: string,
    model?: string,
    options?: {
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    }
  ): Promise<string>;

  /**
   * Get default model name
   */
  getDefaultModel(): string;

  /**
   * Parse tool calls from response text
   */
  parseToolCalls(response: string): Array<{ tool: string; input: Record<string, unknown> }>;
}

/**
 * LLM Adapter factory configuration
 */
export interface LLMAdapterConfig {
  type: 'ollama' | 'gemini' | 'claude';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/**
 * Tool execution result for feedback loop
 */
export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  output?: unknown;
  error?: string;
}

/**
 * Task execution context for LLM
 */
export interface TaskExecutionContext {
  taskId: string;
  systemPrompt?: string;
  maxToolCalls?: number;
  timeout?: number;
  tools: LLMTool[];
}
