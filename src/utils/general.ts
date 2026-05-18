import * as v from "valibot";

export class ThrottledSemaphore {
	private concurrency: number;
	private running = 0;
	private queue: Array<() => void> = [];

	constructor(concurrency: number) {
		this.concurrency = concurrency;
	}

	async acquire(): Promise<void> {
		if (this.running < this.concurrency) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
		this.running++;
	}

	release(): void {
		this.running--;
		const next = this.queue.shift();
		if (next) next();
	}
}

// Generic type 'BaseSchema<TInput$1, TOutput$1, TIssue>' requires 3 type argument(s).
export function valibotParse<T extends v.BaseSchema>(schema: T, input: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, input);
	if (result.success) return result.output;
	throw new Error(`Valibot parse error: ${JSON.stringify(result.issues)}`);
}