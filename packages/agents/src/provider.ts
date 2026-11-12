import OpenAI from 'openai';

/** Provider-neutral model I/O. OpenAI first; any OpenAI-compatible gateway by config (baseURL). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  /** Raw JSON arguments as the model produced them. Always validated before use. */
  arguments: string;
}

export interface ModelTurn {
  /** Final text, if the model answered instead of (or in addition to) calling tools. */
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** Opaque continuation handle for the next step. */
  state?: string;
}

export interface ModelRequest {
  model: string;
  instructions: string;
  /** First step: the user content. Later steps: the tool results for the previous turn's calls. */
  input: string | { callId: string; output: string }[];
  tools: ToolSpec[];
  state?: string;
}

export interface ModelProvider {
  readonly name: string;
  step(req: ModelRequest): Promise<ModelTurn>;
}

/** OpenAI Responses API with function tools; state is carried via previous_response_id. */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(opts: { apiKey?: string; baseURL?: string; timeoutMs?: number } = {}) {
    this.client = new OpenAI({
      // In the cloud dev environment the network proxy injects the key; elsewhere OPENAI_API_KEY is used.
      apiKey: opts.apiKey ?? 'proxy-injected',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: 2,
    });
  }

  async step(req: ModelRequest): Promise<ModelTurn> {
    const input =
      typeof req.input === 'string'
        ? req.input
        : req.input.map((r) => ({
            type: 'function_call_output' as const,
            call_id: r.callId,
            output: r.output,
          }));
    const res = await this.client.responses.create({
      model: req.model,
      instructions: req.instructions,
      input,
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      })),
      ...(req.state ? { previous_response_id: req.state } : {}),
      reasoning: { effort: 'low' },
    });
    const toolCalls: ToolCall[] = [];
    for (const o of res.output) {
      if (o.type === 'function_call')
        toolCalls.push({ callId: o.call_id, name: o.name, arguments: o.arguments });
    }
    return {
      text: res.output_text,
      toolCalls,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      state: res.id,
    };
  }
}

/**
 * Deterministic test mode: a scripted fake model. Each step returns the next scripted turn, or a function of the
 * request (so a script can react to tool results). Runs are reproducible in tests.
 */
export type ScriptedTurn = Partial<ModelTurn> | ((req: ModelRequest) => Partial<ModelTurn>);

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  private i = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  step(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(req);
    const next = this.script[this.i++] ?? { text: 'Done.' };
    const turn = typeof next === 'function' ? next(req) : next;
    return Promise.resolve({
      text: '',
      toolCalls: [],
      inputTokens: 1000,
      outputTokens: 200,
      ...turn,
      state: `scripted-${this.i}`,
    });
  }
}
