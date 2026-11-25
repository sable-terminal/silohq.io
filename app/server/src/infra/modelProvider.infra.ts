// Model endpoints for model-gateway (spec 7.8, 62.7): one interface over the two route
// kinds a cell may configure. Vertex AI zero-retention endpoints in the cell's region
// (commercial) and a self-hosted open-weight model inside the cell (sovereign), reached
// through the OpenAI-compatible chat API that self-hosted servers (vLLM, TGI, llama.cpp)
// expose. Which one a route uses is deployment configuration, like KMS and storage, so
// the choice lives here and nowhere in service code.
//
// Only model-gateway imports this file: "No other service holds model credentials or
// egress to a model endpoint."
//
// Prompts, documents and outputs pass through and are never logged, never put in an
// error message and never kept. An endpoint's error body is dropped unread, because it
// may echo the prompt.

import { readFileSync } from 'node:fs';
import { request as plainRequest, type IncomingHttpHeaders } from 'node:http';
import { request as tlsRequest } from 'node:https';
import { z } from 'zod';
import type { DocumentMediaType, ModelRoute } from '../config/model.config.ts';
import { AppError, isAppError } from '../utils/errors.util.ts';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface ModelRequest {
  /** The task: the caller's instructions and the output contract. */
  system: string;
  /** The vocabulary and the question, as the gateway rendered them. */
  user: string;
  /** document_extraction only: the file, sent as its own part (spec 62.5). */
  document?: { mediaType: DocumentMediaType; data: Buffer } | undefined;
  /** The JSON Schema the output must match, sent as the endpoint's structured output. */
  output: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  /** The caller's request; the route's own timeout is added here. */
  signal: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'filtered' | 'other';

export interface ModelReply {
  /** The model's output. Never logged. */
  text: string;
  /** The model version the endpoint reports, or the route's model. */
  model: string;
  usage: ModelUsage;
  finish: FinishReason;
}

export interface EmbedRequest {
  /** Metadata only (names and descriptions), screened by the gateway first. */
  texts: readonly string[];
  /** document: kept for retrieval; query: what it is retrieved by. */
  task: 'document' | 'query';
  signal: AbortSignal;
}

export interface EmbedReply {
  /** One per text, in order, each of the route's dimensions. Never logged. */
  vectors: number[][];
  model: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  readonly route: ModelRoute;
  generate(request: ModelRequest): Promise<ModelReply>;
  embed(request: EmbedRequest): Promise<EmbedReply>;
}

/** Vectors as the route promises them: one per text, each of its dimensions; anything else is refused, never padded. */
function checkedVectors(vectors: number[][], route: ModelRoute, count: number): number[][] {
  if (vectors.length !== count || vectors.some((v) => v.length !== route.dimensions || v.some((x) => !Number.isFinite(x)))) {
    throw new AppError('upstream', 'the embedding endpoint answered with vectors of the wrong number or length', {
      code: 'model.embedding_dimensions', details: { expected: route.dimensions },
    });
  }
  return vectors;
}

export interface ModelProviderOptions {
  /** Where workload identity tokens come from (GCE_METADATA_HOST). */
  metadataHost: string;
  /** Largest endpoint response read; a larger one is refused. */
  maxResponseBytes?: number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A model version as an endpoint may report it; anything else is replaced by the route's model.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,199}$/;
const modelOf = (reported: string | undefined, route: ModelRoute): string =>
  reported !== undefined && MODEL_ID.test(reported) ? reported : route.model;

export function createModelProvider(route: ModelRoute, options: ModelProviderOptions): ModelProvider {
  const auth = authFor(route, options);
  const ca = route.caFile === undefined ? undefined : readFileSync(route.caFile);
  const http: Http = (url, body, signal) =>
    postJson(url, body, signal, { ca, auth, timeoutMs: route.timeoutMs, maxResponseBytes: options.maxResponseBytes ?? MAX_RESPONSE_BYTES });
  switch (route.provider) {
    case 'vertex_ai':
      return vertexAi(route, http);
    case 'self_hosted':
      return chatCompletions(route, http);
  }
}

// ----------------------------------------------------------------------------- Vertex AI

const vertexReply = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() }).optional(),
    finishReason: z.string().optional(),
  })).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.int().min(0).optional(),
    candidatesTokenCount: z.int().min(0).optional(),
    thoughtsTokenCount: z.int().min(0).optional(),
  }).optional(),
  modelVersion: z.string().optional(),
});

const VERTEX_FINISH: Readonly<Record<string, FinishReason>> = {
  STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'filtered', RECITATION: 'filtered', BLOCKLIST: 'filtered',
  PROHIBITED_CONTENT: 'filtered', SPII: 'filtered',
};

const vertexEmbeddings = z.object({
  predictions: z.array(z.object({
    embeddings: z.object({ values: z.array(z.number()), statistics: z.object({ token_count: z.number().optional() }).optional() }),
  })),
});

function vertexAi(route: ModelRoute, http: Http): ModelProvider {
  if (route.project === undefined) {
    throw new AppError('configuration', `model route ${route.name}: a Vertex AI route names its project`, { code: 'config.model.project' });
  }
  const base = route.endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/v1/projects/${route.project}/locations/${route.region}/publishers/google/models/${route.model}:generateContent`);
  const predict = new URL(`${base}/v1/projects/${route.project}/locations/${route.region}/publishers/google/models/${route.model}:predict`);
  return {
    route,
    async embed(request) {
      const vectors: number[][] = [];
      let tokens = 0;
      for (let i = 0; i < request.texts.length; i += route.embedBatch) {
        const reply = await http(predict, {
          instances: request.texts.slice(i, i + route.embedBatch).map((content) => ({
            content, task_type: request.task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          })),
          parameters: { outputDimensionality: route.dimensions, autoTruncate: false },
        }, request.signal);
        const parsed = vertexEmbeddings.safeParse(reply.json);
        if (!parsed.success) throw invalidReply();
        for (const p of parsed.data.predictions) {
          vectors.push(p.embeddings.values);
          tokens += Math.round(p.embeddings.statistics?.token_count ?? 0);
        }
      }
      return { vectors: checkedVectors(vectors, route, request.texts.length), model: route.model, usage: { inputTokens: tokens, outputTokens: 0, thinkingTokens: 0 } };
    },
    async generate(request) {
      const parts: unknown[] = [{ text: request.user }];
      if (request.document) parts.push({ inlineData: { mimeType: request.document.mediaType, data: request.document.data.toString('base64') } });
      const reply = await http(url, {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          candidateCount: 1,
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: request.output.schema,
        },
      }, request.signal);
      const parsed = vertexReply.safeParse(reply.json);
      if (!parsed.success) throw invalidReply();
      const candidate = parsed.data.candidates?.[0];
      const usage = parsed.data.usageMetadata;
      return {
        text: (candidate?.content?.parts ?? []).filter((p) => p.thought !== true).map((p) => p.text ?? '').join(''),
        model: modelOf(parsed.data.modelVersion, route),
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          thinkingTokens: usage?.thoughtsTokenCount ?? 0,
        },
        finish: VERTEX_FINISH[candidate?.finishReason ?? ''] ?? 'other',
      };
    },
  };
}

// ----------------------------------------------------------------------------- self-hosted

const chatReply = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable().optional() }).optional(),
    finish_reason: z.string().nullable().optional(),
  })).optional(),
  usage: z.object({
    prompt_tokens: z.int().min(0).optional(),
    completion_tokens: z.int().min(0).optional(),
    completion_tokens_details: z.object({ reasoning_tokens: z.int().min(0).optional() }).nullable().optional(),
  }).nullable().optional(),
});

const CHAT_FINISH: Readonly<Record<string, FinishReason>> = { stop: 'stop', length: 'length', content_filter: 'filtered' };

const openAiEmbeddings = z.object({
  data: z.array(z.object({ index: z.int().min(0), embedding: z.array(z.number()) })),
  model: z.string().optional(),
  usage: z.object({ prompt_tokens: z.int().min(0).optional() }).optional(),
});

function chatCompletions(route: ModelRoute, http: Http): ModelProvider {
  // The chat API carries images as data URLs and plain text as text; it has no PDF part.
  if (route.documentMediaTypes.includes('application/pdf')) {
    throw new AppError('configuration', `model route ${route.name}: a self-hosted route cannot read application/pdf`, {
      code: 'config.model.media_type',
    });
  }
  const url = new URL(`${route.endpoint.replace(/\/+$/, '')}/v1/chat/completions`);
  const embeddings = new URL(`${route.endpoint.replace(/\/+$/, '')}/v1/embeddings`);
  return {
    route,
    async embed(request) {
      const vectors: number[][] = [];
      let tokens = 0;
      let model: string | undefined;
      for (let i = 0; i < request.texts.length; i += route.embedBatch) {
        const reply = await http(embeddings, { model: route.model, input: request.texts.slice(i, i + route.embedBatch) }, request.signal);
        const parsed = openAiEmbeddings.safeParse(reply.json);
        if (!parsed.success) throw invalidReply();
        vectors.push(...[...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
        tokens += parsed.data.usage?.prompt_tokens ?? 0;
        model = parsed.data.model;
      }
      return { vectors: checkedVectors(vectors, route, request.texts.length), model: modelOf(model, route), usage: { inputTokens: tokens, outputTokens: 0, thinkingTokens: 0 } };
    },
    async generate(request) {
      let content: unknown = request.user;
      if (request.document) {
        const { mediaType, data } = request.document;
        content = [
          { type: 'text', text: request.user },
          mediaType === 'text/plain'
            ? { type: 'text', text: data.toString('utf8') }
            : { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data.toString('base64')}` } },
        ];
      }
      const reply = await http(url, {
        model: route.model,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content }],
        n: 1,
        temperature: 0,
        max_tokens: request.maxOutputTokens,
        response_format: { type: 'json_schema', json_schema: { name: request.output.name, schema: request.output.schema, strict: true } },
      }, request.signal);
      const parsed = chatReply.safeParse(reply.json);
      if (!parsed.success) throw invalidReply();
      const choice = parsed.data.choices?.[0];
      const usage = parsed.data.usage;
      const thinking = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return {
        text: choice?.message?.content ?? '',
        model: modelOf(parsed.data.model, route),
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          // Completion tokens include reasoning tokens here; the ledger keeps them apart.
          outputTokens: Math.max(0, (usage?.completion_tokens ?? 0) - thinking),
          thinkingTokens: thinking,
        },
        finish: CHAT_FINISH[choice?.finish_reason ?? ''] ?? 'other',
      };
    },
  };
}

// ----------------------------------------------------------------------------- authentication

type Auth = () => Promise<string | undefined>;

function authFor(route: ModelRoute, options: ModelProviderOptions): Auth {
  const { auth } = route;
  if (auth.kind === 'bearer_file') {
    let token: string;
    try {
      token = readFileSync(auth.file, 'utf8').trim();
    } catch {
      throw new AppError('configuration', `model route ${route.name}: cannot read its token file`, { code: 'config.model.token_file' });
    }
    if (token === '') throw new AppError('configuration', `model route ${route.name}: its token file is empty`, { code: 'config.model.token_file' });
    return async () => token;
  }
  if (auth.kind === 'workload_identity') return metadataToken(options.metadataHost);
  return async () => undefined;
}

const tokenReply = z.object({ access_token: z.string().min(1), expires_in: z.int().min(1) });

// An access token for the pod's service account from the metadata server, kept until a
// minute before it expires. One fetch at a time.
function metadataToken(host: string): Auth {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const url = new URL(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`);
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    pending ??= (async () => {
      try {
        const reply = await getJson(url, { 'metadata-flavor': 'Google' }, AbortSignal.timeout(5_000));
        const parsed = tokenReply.safeParse(reply.json);
        if (reply.status !== 200 || !parsed.success) {
          throw new AppError('unavailable', 'the metadata server did not issue a token', { code: 'model.credentials_unavailable' });
        }
        cached = { token: parsed.data.access_token, until: Date.now() + (parsed.data.expires_in - 60) * 1000 };
        return parsed.data.access_token;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

// ----------------------------------------------------------------------------- HTTP

interface JsonReply {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

type Http = (url: URL, body: unknown, signal: AbortSignal) => Promise<JsonReply>;

const invalidReply = (): AppError =>
  new AppError('upstream', 'the model endpoint answered with a body the gateway cannot read', { code: 'model.provider_reply_invalid' });

// The route's timeout, told apart from the caller going away.
class TimedOut extends Error {
  readonly limitMs: number;

  constructor(limitMs: number) {
    super('timed out');
    this.limitMs = limitMs;
  }
}

interface PostOptions {
  ca: Buffer | undefined;
  auth: Auth;
  timeoutMs: number;
  maxResponseBytes: number;
}

async function postJson(url: URL, body: unknown, callerSignal: AbortSignal, options: PostOptions): Promise<JsonReply> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new TimedOut(options.timeoutMs)), options.timeoutMs);
  const signal = AbortSignal.any([callerSignal, timeout.signal]);
  try {
    const token = await options.auth();
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const reply = await send(url, 'POST', {
      'content-type': 'application/json', accept: 'application/json', 'content-length': String(payload.length),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }, payload, signal, options.ca, options.maxResponseBytes);
    if (reply.status >= 200 && reply.status < 300) return reply;
    throw statusError(reply);
  } finally {
    clearTimeout(timer);
  }
}

const getJson = (url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<JsonReply> =>
  send(url, 'GET', { accept: 'application/json', ...headers }, undefined, signal, undefined, 64 * 1024);

// The endpoint's status as a category. Its body is not read into the error.
function statusError(reply: JsonReply): AppError {
  const { status } = reply;
  const details = { status };
  if (status === 429) {
    const header = reply.headers['retry-after'];
    const retryAfterSeconds = typeof header === 'string' && /^\d{1,4}$/.test(header) ? Number(header) : 2;
    return new AppError('capacity', 'the model endpoint is at capacity', { code: 'model.provider_capacity', details, retryAfterSeconds });
  }
  if (status === 401 || status === 403) {
    return new AppError('configuration', 'the model endpoint refused the gateway\'s credentials', { code: 'model.provider_auth', details });
  }
  if (status >= 500) return new AppError('upstream', `the model endpoint failed (${status})`, { code: 'model.provider_error', details, retryable: true });
  return new AppError('upstream', `the model endpoint rejected the request (${status})`, { code: 'model.provider_rejected', details });
}

function send(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal,
  ca: Buffer | undefined, maxResponseBytes: number): Promise<JsonReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const secure = url.protocol === 'https:';
    const req = (secure ? tlsRequest : plainRequest)(url, {
      method, headers, signal, ...(secure && ca ? { ca } : {}), ...(secure ? { minVersion: 'TLSv1.2' as const } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          req.destroy(new AppError('upstream', `the model endpoint's answer exceeded ${maxResponseBytes} bytes`, {
            code: 'model.provider_reply_too_large', details: { limit: maxResponseBytes },
          }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
      res.on('error', (error) => reject(transportError(error, signal)));
    });
    req.on('error', (error) => reject(transportError(error, signal)));
    req.end(body);
  });
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason instanceof TimedOut) {
    return new AppError('timeout', `the model endpoint did not answer within ${reason.limitMs} ms`, {
      code: 'model.timeout', details: { limit: reason.limitMs }, retryable: true,
    });
  }
  return reason;
}

function transportError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return abortError(signal);
  if (isAppError(error)) return error;
  return new AppError('unavailable', 'the model endpoint could not be reached', { code: 'model.provider_unreachable', cause: error });
}
