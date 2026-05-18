export const mathStages: VerificationStage[] = [
	syntaxCheck,             // checks Lean syntax
	consistencyCheck,        // against known theorems
	proofCheck,              // runs lean
];