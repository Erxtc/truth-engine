/* AUTO-GENERATED FILE from src/db/gen-types.ts */

export interface DB {
  problems: {
    id: string
    domain: string
    description: string
    status: string
    created_at: number
    updated_at: number
  }
  artifacts: {
    id: string
    type: string
    status: string
    problem_id: string
    parent_id: string | null
    depth: number
    score: number
    title: string | null
    hypothesis_text: string | null
    formal_statement: string | null
    source_code: string | null
    payload: string | null
    latest_execution_id: string | null
    provenance: string | null
    created_at: number
    updated_at: number
    workspace_path: string | null
  }
  relations: {
    id: string
    source_id: string
    target_id: string
    relation_type: string
    properties: string | null
    created_at: number
  }
  executions: {
    id: string
    artifact_id: string
    execution_type: string
    passed: number
    metrics: string | null
    error_log: string | null
    test_results: string | null
    runtime_ms: number | null
    created_at: number
  }
  agent_logs: {
    id: string
    artifact_id: string | null
    agent_role: string
    input_context: string | null
    response: string | null
    cost: number | null
    timestamp: number
  }
}
