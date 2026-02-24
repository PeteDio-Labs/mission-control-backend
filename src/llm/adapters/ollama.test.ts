/**
 * Ollama LLM Adapter Tests
 * Phase 3B.2 - LLM Provider Adapters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaLLMAdapter } from './ollama';
import * as OllamaConnectorModule from '../../connectors/ollama';

// Mock the Ollama connector
vi.mock('../../connectors/ollama', () => ({
  OllamaConnector: vi.fn(),
}));

describe('OllamaLLMAdapter', () => {
  let adapter: OllamaLLMAdapter;
  let mockConnector: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnector = {
      testConnection: vi.fn(),
      listModels: vi.fn(),
      chat: vi.fn(),
      generate: vi.fn(),
      getDefaultModel: vi.fn().mockReturnValue('mistral'),
    };

    const MockedOllamaConnector = OllamaConnectorModule.OllamaConnector as any;
    MockedOllamaConnector.mockImplementation(() => mockConnector);

    adapter = new OllamaLLMAdapter('http://ollama.test:11434', 'mistral');
  });

  describe('initialization', () => {
    it('should initialize with provided URL and model', () => {
      expect(adapter.name).toBe('ollama');
      expect(adapter.supportsStreaming).toBe(false);
      expect(adapter.supportsToolCalling).toBe(true);
    });

    it('should get default model', () => {
      expect(adapter.getDefaultModel()).toBe('mistral');
      expect(mockConnector.getDefaultModel).toHaveBeenCalled();
    });
  });

  describe('isConfigured', () => {
    it('should return true if connection is successful', async () => {
      mockConnector.testConnection.mockResolvedValueOnce(true);

      const result = await adapter.isConfigured();

      expect(result).toBe(true);
      expect(mockConnector.testConnection).toHaveBeenCalled();
    });

    it('should return false if connection fails', async () => {
      mockConnector.testConnection.mockResolvedValueOnce(false);

      const result = await adapter.isConfigured();

      expect(result).toBe(false);
    });

    it('should handle connection errors gracefully', async () => {
      mockConnector.testConnection.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await adapter.isConfigured();

      expect(result).toBe(false);
    });
  });

  describe('listModels', () => {
    it('should return list of available models', async () => {
      mockConnector.listModels.mockResolvedValueOnce([
        { name: 'mistral:latest', size: 4000000000 },
        { name: 'llama3:latest', size: 8000000000 },
      ]);

      const models = await adapter.listModels();

      expect(models).toEqual(['mistral:latest', 'llama3:latest']);
      expect(mockConnector.listModels).toHaveBeenCalled();
    });

    it('should handle model listing errors', async () => {
      mockConnector.listModels.mockRejectedValueOnce(new Error('Failed to list models'));

      await expect(adapter.listModels()).rejects.toThrow('Failed to list available models from Ollama');
    });

    it('should handle empty model list', async () => {
      mockConnector.listModels.mockResolvedValueOnce([]);

      const models = await adapter.listModels();

      expect(models).toEqual([]);
    });
  });

  describe('generateCompletion', () => {
    it('should generate completion without tools', async () => {
      mockConnector.chat.mockResolvedValueOnce({
        model: 'mistral',
        message: { role: 'assistant', content: 'Hello, how can I help?' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
      });

      const result = await adapter.generateCompletion('What is 2+2?');

      expect(result.content).toBe('Hello, how can I help?');
      expect(result.model).toBe('mistral');
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      });
    });

    it('should generate completion with tool definitions', async () => {
      const tools = [
        {
          name: 'get_status',
          description: 'Get system status',
          input_schema: {
            type: 'object' as const,
            properties: { system: { type: 'string' } },
            required: ['system'],
          },
        },
      ];

      mockConnector.chat.mockResolvedValueOnce({
        model: 'mistral',
        message: { role: 'assistant', content: 'I will check the status.' },
        done: true,
        prompt_eval_count: 50,
        eval_count: 30,
      });

      const result = await adapter.generateCompletion('Check Proxmox status', tools);

      expect(result.content).toContain('check the status');

      // Verify chat was called with system prompt containing tool definitions
      expect(mockConnector.chat).toHaveBeenCalled();
      const callArgs = mockConnector.chat.mock.calls[0];
      expect(callArgs[0]).toHaveLength(2); // system + user messages
      expect(callArgs[0][0].role).toBe('system');
      expect(callArgs[0][0].content).toContain('Tool: get_status');
      expect(callArgs[0][1].role).toBe('user');
      expect(callArgs[0][1].content).toBe('Check Proxmox status');
    });

    it('should use provided model', async () => {
      mockConnector.chat.mockResolvedValueOnce({
        model: 'llama3',
        message: { role: 'assistant', content: 'Response from llama3' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
      });

      await adapter.generateCompletion('Test', undefined, 'llama3');

      expect(mockConnector.chat).toHaveBeenCalledWith(
        expect.any(Array),
        'llama3'
      );
    });

    it('should handle completion errors', async () => {
      mockConnector.chat.mockRejectedValueOnce(new Error('API timeout'));

      await expect(adapter.generateCompletion('Test prompt')).rejects.toThrow(
        'Failed to generate completion: API timeout'
      );
    });

    it('should handle missing token counts', async () => {
      mockConnector.chat.mockResolvedValueOnce({
        model: 'mistral',
        message: { role: 'assistant', content: 'Response' },
        done: true,
      });

      const result = await adapter.generateCompletion('Test');

      expect(result.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  describe('generate', () => {
    it('should generate text from prompt', async () => {
      mockConnector.generate.mockResolvedValueOnce({
        model: 'mistral',
        response: 'The answer is 4',
        done: true,
      });

      const result = await adapter.generate('What is 2+2?');

      expect(result).toBe('The answer is 4');
      expect(mockConnector.generate).toHaveBeenCalledWith('What is 2+2?', undefined);
    });

    it('should use specified model', async () => {
      mockConnector.generate.mockResolvedValueOnce({
        response: 'Generated text',
        done: true,
      });

      await adapter.generate('Test', 'llama3');

      expect(mockConnector.generate).toHaveBeenCalledWith('Test', 'llama3');
    });

    it('should handle generation errors', async () => {
      mockConnector.generate.mockRejectedValueOnce(new Error('Model not found'));

      await expect(adapter.generate('Test')).rejects.toThrow(
        'Failed to generate text: Model not found'
      );
    });
  });

  describe('parseToolCalls', () => {
    it('should parse single tool call from response', () => {
      const response = `Let me check the status.
\`\`\`json
{
  "tool": "get_proxmox_status",
  "input": {
    "node": "pve"
  }
}
\`\`\`
Here are the results.`;

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        tool: 'get_proxmox_status',
        input: { node: 'pve' },
      });
    });

    it('should parse multiple tool calls', () => {
      const response = `First action:
\`\`\`json
{
  "tool": "get_status",
  "input": { "type": "proxmox" }
}
\`\`\`
Second action:
\`\`\`json
{
  "tool": "get_resources",
  "input": { "filter": "running" }
}
\`\`\`
Done.`;

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(2);
      expect(calls[0].tool).toBe('get_status');
      expect(calls[1].tool).toBe('get_resources');
    });

    it('should handle malformed JSON gracefully', () => {
      const response = `Attempting to use tool:
\`\`\`json
{
  "tool": "test",
  "input": { invalid json
}
\`\`\`
Continuing...`;

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(0);
    });

    it('should handle missing tool or input fields', () => {
      const response = `\`\`\`json
{
  "tool": "test"
}
\`\`\`
and
\`\`\`json
{
  "input": { "key": "value" }
}
\`\`\`
end`;

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(0);
    });

    it('should handle response without tool calls', () => {
      const response = 'This is a normal response without any tool calls.';

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(0);
    });

    it('should extract nested objects from tool input', () => {
      const response = `\`\`\`json
{
  "tool": "complex_tool",
  "input": {
    "config": {
      "nested": {
        "value": "test"
      }
    },
    "array": [1, 2, 3]
  }
}
\`\`\``;

      const calls = adapter.parseToolCalls(response);

      expect(calls).toHaveLength(1);
      expect(calls[0].input.config).toEqual({
        nested: { value: 'test' },
      });
      expect(calls[0].input.array).toEqual([1, 2, 3]);
    });
  });

  describe('create factory', () => {
    it('should create adapter instance', () => {
      const newAdapter = OllamaLLMAdapter.create('http://ollama:11434', 'llama3');

      expect(newAdapter).toBeInstanceOf(OllamaLLMAdapter);
      expect(newAdapter.name).toBe('ollama');
    });

    it('should use default parameters', () => {
      const newAdapter = OllamaLLMAdapter.create();

      expect(newAdapter).toBeInstanceOf(OllamaLLMAdapter);
    });
  });

  describe('integration', () => {
    it('should handle full task execution flow', async () => {
      const tools = [
        {
          name: 'restart_vm',
          description: 'Restart a VM',
          input_schema: {
            type: 'object' as const,
            properties: { vmid: { type: 'number' } },
            required: ['vmid'],
          },
        },
      ];

      mockConnector.chat.mockResolvedValueOnce({
        model: 'mistral',
        message: {
          role: 'assistant',
          content: `I'll restart the VM for you.
\`\`\`json
{
  "tool": "restart_vm",
  "input": { "vmid": 100 }
}
\`\`\`
The restart command has been queued.`,
        },
        done: true,
        prompt_eval_count: 40,
        eval_count: 50,
      });

      const response = await adapter.generateCompletion(
        'Restart VM 100',
        tools
      );

      expect(response.content).toContain('restart the VM');

      const toolCalls = adapter.parseToolCalls(response.content);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].tool).toBe('restart_vm');
      expect(toolCalls[0].input.vmid).toBe(100);
    });
  });
});
