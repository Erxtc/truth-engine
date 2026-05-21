/* AUTO-GENERATED FILE from src/db/gen-types.ts */

export interface DB {
  problems: {
    id: string
    domain: string
    description: string
    status: string
    stepPlan: string | null
    currentStep: number
    createdAt: number
    updatedAt: number
  }
  artifacts: {
    id: string
    workspacePath: string | null
    type: string
    status: string
    problemId: string
    parentId: string | null
    depth: number
    score: number
    title: string | null
    hypothesisText: string | null
    formalStatement: string | null
    sourceCode: string | null
    payload: string | null
    latestExecutionId: string | null
    provenance: string | null
    createdAt: number
    updatedAt: number
  }
  relations: {
    id: string
    sourceId: string
    targetId: string
    relationType: string
    properties: string | null
    createdAt: number
  }
  executions: {
    id: string
    artifactId: string
    executionType: string
    passed: number
    metrics: string | null
    errorLog: string | null
    testResults: string | null
    runtimeMs: number | null
    createdAt: number
  }
  agent_logs: {
    id: string
    artifactId: string | null
    agentRole: string
    inputContext: string | null
    response: string | null
    cost: number | null
    timestamp: number
  }
}
