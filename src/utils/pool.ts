export async function asyncPool<T>(
	concurrency: number,
	items: T[],
	fn: (item: T) => Promise<void>
) {
	const queue = [...items];
	const workers = new Array(concurrency).fill(null).map(async () => {
		while (queue.length) {
			const item = queue.shift();
			if (item) await fn(item);
		}
	});
	await Promise.all(workers);
}