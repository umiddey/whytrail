// One HTTP module. No SDK. Tests inject `http` and never call the network.

export type HttpRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

export type HttpResponse = { status: number; body: string };
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export const OPENROUTER_ORIGIN = "https://openrouter.ai/api/v1";
export const DEFAULT_CLASSIFY_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small";

export const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    born: { type: "string", enum: ["bug", "perf", "feature", "change", "taste"] },
    outcome: { type: "string" },
    confidence: { type: "number" },
    builds_on: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          plan: { type: "string" },
          yes: { type: "boolean" },
          confidence: { type: "number" },
        },
        required: ["plan", "yes", "confidence"],
      },
    },
  },
  required: ["born", "outcome", "confidence", "builds_on"],
} as const;

export type OpenRouterClient = {
  classify(user: string): Promise<unknown>;
  embed(texts: string[]): Promise<number[][]>;
};

async function defaultHttp(req: HttpRequest): Promise<HttpResponse> {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, body: await res.text() };
}

export function openRouter(opts: {
  apiKey: string;
  classifyModel: string;
  embedModel: string;
  http?: HttpClient;
}): OpenRouterClient {
  const http = opts.http ?? defaultHttp;
  const headers = { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" };
  return {
    async classify(user: string): Promise<unknown> {
      const res = await http({
        url: `${OPENROUTER_ORIGIN}/chat/completions`,
        method: "POST",
        headers,
        body: JSON.stringify({
          model: opts.classifyModel,
          messages: [
            { role: "system", content: "Reply with JSON matching the schema. Do not invent a plan id that was not listed." },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "plan_card", strict: true, schema: CARD_SCHEMA },
          },
        }),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`OpenRouter chat failed (${res.status})`);
      const parsed = JSON.parse(res.body) as { choices?: { message?: { content?: string } }[] };
      const content = parsed.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter chat returned no content");
      return JSON.parse(content);
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await http({
        url: `${OPENROUTER_ORIGIN}/embeddings`,
        method: "POST",
        headers,
        body: JSON.stringify({ model: opts.embedModel, input: texts }),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`OpenRouter embeddings failed (${res.status})`);
      const parsed = JSON.parse(res.body) as { data?: { index: number; embedding: number[] }[] };
      const ranked: number[][] = [];
      for (const row of parsed.data ?? []) ranked[row.index] = row.embedding;
      if (ranked.length !== texts.length || ranked.some((row) => !row)) {
        throw new Error("OpenRouter embeddings returned a short result");
      }
      return ranked;
    },
  };
}
