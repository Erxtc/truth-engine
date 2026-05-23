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

/**
 * Strip TypeScript type annotations using Bun's built-in transpiler.
 * Falls back to the original source if transpilation fails (plain JS passes through unchanged).
 */
export function transpileToJs(source: string): string {
	try {
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		return transpiler.transformSync(source);
	} catch {
		return source;
	}
}

export function valibotParse<T extends v.GenericSchema>(schema: T, input: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, input);
	if (result.success) return result.output;

	// Clean, readable error — valibot issues blobs are huge
	const issues = result.issues.map((issue: any) => {
		const path = issue.path?.map((p: any) => p.key ?? p.item ?? p).join(".") || "<root>";
		const msg = issue.message ?? "unknown error";
		const expected = issue.expected ?? issue.type ?? "?";
		const received = typeof issue.received === "string" ? issue.received.slice(0, 40) : typeof issue.received;
		return `  ${path}: ${msg} (expected ${expected}, got ${String(received)})`;
	});
	throw new Error(`Valibot (${result.issues.length} issue${result.issues.length > 1 ? "s" : ""}):\n${issues.join("\n")}`);
}