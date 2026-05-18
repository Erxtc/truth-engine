export class CustomError extends Error {
	public context?: unknown;

	constructor(message: string, context?: unknown) {
		super(message);
		this.name = "CustomError";
		this.context = context;
	}
}

export class SafeCancel extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SafeCancel";
	}
}