import { queryLlm } from "./src/llm/perplexity";
import { llmResponseSchema } from "./src/main";
import * as Bun from 'bun';

export type ResearchNode = {
	id: string;

	problem: string;

	hypothesis: string;

	expected_benefit: string;

	assumptions: string[];

	possible_failure_modes: {
		condition: string;
		issue: string;
	}[];

	suggested_tests: {
		test_name: string;
		description: string;
	}[];

	status:
	| 'generated'
	| 'validated'
	| 'rejected';

	cheap_score?: number;

	rejection_reason?: string;
};

export async function generateResearchNode(
	problem: string
): Promise<ResearchNode> {
	const result = await queryLlm(
		buildPrompt(problem),
		llmResponseSchema
	);

	return {
		id: Bun.randomUUIDv7(),
		problem,
		...result,
		status: 'generated',
	};
}

export function reject(
	node: ResearchNode,
	reason: string
): ResearchNode {
	return {
		...node,
		status: 'rejected',
		rejection_reason: reason,
	};
}


export type ExecutableTest = {
	name: string;

	run: () => Promise<TestResult>;
};

export type TestResult = {
	success: boolean;

	duration_ms: number;

	error?: string;
};