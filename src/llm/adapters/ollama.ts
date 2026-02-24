/**
 * Ollama LLM Adapter
 * Implements LLMAdapter interface for local Ollama inference
 * Phase 3B.2 - LLM Provider Adapters
 */

import { OllamaConnector, OllamaChatMessage, OllamaChatResponse } from '../../connectors/ollama';
import { logger } from '../../utils/logger';

/**
 * Tool definition for LLM tool-calling
 * Used by task execution engine
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
 * LLM Response with tool calls
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
 * Ollama LLM Adapter
 * Provides unified interface for Ollama LLM inference
 * Compatible with task execution engine
 */
export class OllamaLLMAdapter {
  private connector: OllamaConnector;
  name = 'ollama';
  supportsStreaming = false; // Phase 3C feature
  supportsToolCalling = true;

  constructor(baseUrl?: string, model?: string) {
    this.connector = new OllamaConnector(baseUrl, model);
  }

  /**
   * Check if adapter is properly configured
   */
  async isConfigured(): Promise<boolean> {
    try {
      return await this.connector.testConnection();
    } catch (error) {
      logger.error('Ollama configuration check failed', { error });
      return false;
    }
  }

  /**
   * List available models from Ollama
   */
  async listModels(): Promise<string[]> {
    try {
      const models = await this.connector.listModels();
      return models.map((m) => m.name);
    } catch (error) {
      logger.error('Failed to list Ollama models', { error });
      throw new Error('Failed to list available models from Ollama');
    }
  }

  /**
   * Generate completion from prompt
   * Primary method for task execution engine
   */
  async generateCompletion(
    prompt: string,
    tools?: LLMTool[],
    model?: string,
    options?: {
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    }
  ): Promise<LLMResponse> {
    try {
      // Convert system message + user message format for Ollama
      const messages: OllamaChatMessage[] = [
        {
          role: 'system',
          content:
            tools && tools.length > 0
              ? this.buildSystemPromptWithTools(tools)
              : 'You are a helpful AI assistant.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ];

      const response = (await this.connector.chat(
        messages,
        model
      )) as OllamaChatResponse;

      return {
        content: response.message.content,
        stop_reason: response.done ? 'end_turn' : 'length',
        model: response.model,
        usage: {
          prompt_tokens: response.prompt_eval_count || 0,
          completion_tokens: response.eval_count || 0,
          total_tokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
        },
      };
    } catch (error) {
      logger.error('Ollama completion generation failed', { error, prompt });
      throw new Error(`Failed to generate completion: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate text from simple prompt (legacy method)
   */
  async generate(
    prompt: string,
    model?: string,
    options?: {
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    }
  ): Promise<string> {
    try {
      const response = await this.connector.generate(prompt, model);
      return response.response;
    } catch (error) {
      logger.error('Ollama generation failed', { error });
      throw new Error(`Failed to generate text: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get default model name
   */
  getDefaultModel(): string {
    return this.connector.getDefaultModel();
  }

  /**
   * Build system prompt with tool definitions
   * Format tools for Ollama to understand
   */
  private buildSystemPromptWithTools(tools: LLMTool[]): string {
    const toolDefinitions = tools
      .map(
        (tool) => `
### Tool: ${tool.name}
Description: ${tool.description}
Input schema: ${JSON.stringify(tool.input_schema, null, 2)}
`
      )
      .join('\n');

    return `You are a helpful AI assistant with access to the following tools:

${toolDefinitions}

When you need to use a tool, respond with a JSON block like:
\`\`\`json
{
  "tool": "tool_name",
  "input": {
    "param1": "value1",
    "param2": "value2"
  }
}
\`\`\`

Always include your thinking before and after tool calls. Be concise and helpful.`;
  }

  /**
   * Parse tool calls from response
   * Extracts JSON tool call blocks from LLM response
   */
  parseToolCalls(response: string): Array<{ tool: string; input: Record<string, unknown> }> {
    const toolCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];

    try {
      // Find JSON blocks in response
      const jsonRegex = /```json\n([\s\S]*?)\n```/g;
      let match;

      while ((match = jsonRegex.exec(response)) !== null) {
        const parsed = JSON.parse(match[1]);

        if (parsed.tool && parsed.input) {
          toolCalls.push({
            tool: parsed.tool,
            input: parsed.input,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to parse tool calls from response', { error, response });
    }

    return toolCalls;
  }

  /**
   * Static factory for use with dependency injection
   */
  static create(baseUrl?: string, model?: string): OllamaLLMAdapter {
    return new OllamaLLMAdapter(baseUrl, model);
  }

  /**
   * Check if this adapter is available
   */
  static isAvailable(): boolean {
    return OllamaConnector.isConfigured();
  }
}

export default OllamaLLMAdapter;
