export const physicsStages: VerificationStage[] = [
	syntaxCheck,             // check simulation config
	consistencyCheck,        // against physical laws
	simulationRun,
	benchmarkComparison,
	invariantCheck,
];