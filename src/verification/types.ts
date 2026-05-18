import type { Artifact } from "../db/schema";
import type { WorkingContext } from "../core/types";

export interface StageResult {
	stageName: string;
	passed: boolean;
	reason?: string;
	metrics?: Record<string, number>;
	artifacts?: Record<string, string>;
	testResults?: Array<{ name: string; passed: boolean; detail?: string }>;
	runtimeMs: number;
}

export interface VerificationStage {
	name: string;
	run(artifact: Artifact, context: WorkingContext): Promise<StageResult>;
}

export interface PipelineResult {
	overallPassed: boolean;
	stages: StageResult[];
	finalMetrics: Record<string, number>;
}