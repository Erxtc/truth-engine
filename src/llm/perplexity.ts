import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { jsonrepair } from 'jsonrepair';
import { CustomError } from '../utils/log';
import { ThrottledSemaphore, valibotParse } from '../utils/general';

/**
 * Takes a almost JSON string input and formats it to correct JSON.
 * @param input - Any string that looks like key-value pairs
 * @returns - The fixed parsed object
 */
function fixJson(input: string): object {
	// Wrap input in braces if not already
	let wrapped = input.trim();
	if (!wrapped.startsWith('{')) { wrapped = `{${wrapped}}`; }

	// Escape unescaped double quotes inside string values
	wrapped = wrapped.replace(/"([^"]*?)'([^"]*?)"/g, `"$1\\'$2"`); // handle single quotes inside double quotes

	// Replace single quotes for values with double quotes
	wrapped = wrapped.replace(/:\s*'([^']*?)'/g, ': "$1"');
	const repaired = jsonrepair(wrapped);
	return JSON.parse(repaired);
}

const perplexityResponseSchema = v.object({
	// Top-level fields
	id: v.string(),
	object: v.string(),
	model: v.string(),
	status: v.string(),
	created_at: v.number(),
	completed_at: v.number(),
	instructions: v.string(),

	// Output array contains the actual response content
	output: v.array(
		v.object({
			type: v.string(),
			id: v.optional(v.string()),
			role: v.optional(v.string()),
			status: v.optional(v.string()),
			// For message type (the actual LLM response)
			content: v.optional(
				v.array(
					v.object({
						type: v.string(),
						text: v.string(),
						annotations: v.array(v.any()),
						logprobs: v.array(v.any()),
					})
				)
			),
			// For search_results type
			queries: v.optional(v.array(v.string())),
			results: v.optional(
				v.array(
					v.object({
						id: v.number(),
						title: v.string(),
						url: v.string(),
						snippet: v.string(),
						source: v.string(),
						date: v.optional(v.nullable(v.string())),
						last_updated: v.optional(v.nullable(v.string())),
					})
				)
			),
		})
	),

	// Usage information
	usage: v.object({
		input_tokens: v.number(),
		output_tokens: v.number(),
		total_tokens: v.number(),
		input_tokens_details: v.object({
			cached_tokens: v.number(),
		}),
		output_tokens_details: v.object({
			reasoning_tokens: v.number(),
		}),
		tool_calls_details: v.object({
			search_web: v.optional(
				v.object({
					invocation: v.number(),
				})
			),
		}),
		cost: v.object({
			currency: v.string(),
			input_cost: v.number(),
			output_cost: v.number(),
			tool_calls_cost: v.number(),
			total_cost: v.number(),
		}),
	}),

	// Tools configuration
	tools: v.array(
		v.object({
			type: v.string(),
		})
	),

	// Additional fields
	temperature: v.number(),
	top_p: v.number(),
	presence_penalty: v.number(),
	frequency_penalty: v.number(),
	max_output_tokens: v.number(),
	parallel_tool_calls: v.boolean(),
	tool_choice: v.string(),
	truncation: v.string(),
	store: v.boolean(),
	service_tier: v.string(),

	// Optional fields
	background: v.optional(v.boolean()),
	error: v.optional(v.nullable(v.any())),
	incomplete_details: v.optional(v.nullable(v.any())),
	metadata: v.optional(v.record(v.string(), v.any())),
	previous_response_id: v.optional(v.nullable(v.string())),
	prompt_cache_key: v.optional(v.nullable(v.string())),
	reasoning: v.optional(v.nullable(v.any())),
	safety_identifier: v.optional(v.nullable(v.string())),
	text: v.optional(
		v.object({
			format: v.object({
				type: v.string(),
			}),
		})
	),
	user: v.optional(v.nullable(v.string())),
});

if (!import.meta.env.PERPLEXITY_API_KEY) {
	throw new Error('Environment variable \'PERPLEXITY_API_KEY\' is missing');
}

interface QueryLlmResponse<T> {
	response: T;
	llmCost: number;
}

const LOG_LLM_RESPONSE = false;
const semaphore = new ThrottledSemaphore(10);

/**
 * Sends a prompt to the Perplexity API and validates the response against the given schema.
 *
 * @param prompt The prompt sent to the LLM.
 * @param schema A Valibot schema used to validate the LLM's response.
 *
 * @returns Validated & parsed response.
 */
export async function queryLlm<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	prompt: string,
	schema: T,
): Promise<QueryLlmResponse<v.InferOutput<T>>> {
	await semaphore.acquire();
	try {
		const { $schema: _, ...jsonSchema } = toJsonSchema(schema);

		const responseFormat = {
			type: 'json_schema',
			json_schema: {
				additionalProperties: false,
				schema: { ...jsonSchema, additionalProperties: false },
			},
		};

		const payload = {
			model: 'llama-3.1-sonar-small-128k-online',
			input: prompt,
			instructions: "You are an AI research assistant. Output valid JSON matching the schema exactly. Do not include any text outside the JSON.",
			tools: [
				{
					type: "web_search",
					search_recency_filter: 'week',
				}
			],
			max_output_tokens: 7000,
			temperature: 0.7,
			top_p: 0.9,
			response_format: responseFormat,
			stream: false,
		};

		const url = 'https://api.perplexity.ai/v1/agent';

		const response = await fetch(url, {
			method: 'POST',
			body: JSON.stringify(payload),
			headers: {
				Authorization: `Bearer ${import.meta.env.PERPLEXITY_API_KEY}`,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		});

		if (response.status === 401) {
			console.error('Out of Perplexity API credits, stopping process');
			process.exit(0);
		} else if (!response.ok) {
			throw new Error(`GET '${url}' failed with status '${response.status}'\n${await response.text()}`);
		}

		// =====

		const body = valibotParse(perplexityResponseSchema, await response.json());
		if (body.error) {
			throw new CustomError('Deepseek api error', { x: body.error, payload, body })
		}

		if (LOG_LLM_RESPONSE) {
			console.dir(body, { depth: 10 });
		}

		let contentTxt = '';
		for (const out of body.output) {
			if (out.content && out.content[0]?.text) {
				contentTxt = out.content[0].text;
				break;
			}
		}
		if (!contentTxt) throw new CustomError('No text content in LLM response', { body });

		let data;
		try {
			// Note: LLM frequently responds with broken unparsable JSON
			data = fixJson(contentTxt);
		} catch {
			throw new CustomError(`Error while Parsing schema`, { contentTxt, body });
		}

		return {
			response: valibotParse(schema, data),
			llmCost: body.usage.cost?.total_cost,
		};
	} finally {
		semaphore.release();
	}
}
