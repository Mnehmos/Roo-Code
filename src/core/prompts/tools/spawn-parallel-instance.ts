import { ToolArgs } from "./types"

/**
 * Generates the spawn_parallel_instance tool description.
 * This tool is restricted to Orchestrator mode only.
 */
export function getSpawnParallelInstanceDescription(args: ToolArgs): string {
	return `## spawn_parallel_instance
Description: Spawn a parallel worker instance with isolated workspace for concurrent task execution. This tool is **ONLY available in Orchestrator mode** and allows creating independent worker agents that execute in parallel with custom system prompts and workspace isolation.

**IMPORTANT**: This tool is restricted to Orchestrator mode. Attempting to use it from other modes will result in an error.

Parameters:
- taskId: (required) Unique identifier for this parallel task (e.g., "auth-impl-1", "api-refactor-2")
- workspacePath: (required) Isolated workspace directory path relative to project root (e.g., "./src/auth", "./src/api/routes")
- systemPrompt: (required) Custom system prompt that defines the worker's specialization and task objectives
- mcpServers: (optional) Comma-separated list or JSON array of MCP server names to enable for this worker (e.g., "playwright,github" or ["playwright","github"])

Returns:
- workerId: Unique worker identifier
- status: Worker spawn status ("spawned" or "error")
- workspace: Confirmed workspace path
- error: Error message if spawn failed

Usage:
<spawn_parallel_instance>
<taskId>unique-task-identifier</taskId>
<workspacePath>./path/to/isolated/workspace</workspacePath>
<systemPrompt>Your custom system prompt defining worker specialization and task</systemPrompt>
<mcpServers>server1,server2</mcpServers>
</spawn_parallel_instance>

Example: Spawning a worker to implement authentication module
<spawn_parallel_instance>
<taskId>auth-implementation-1</taskId>
<workspacePath>./src/auth</workspacePath>
<systemPrompt>You are implementing JWT-based authentication in the auth module. Focus on:
1. Login endpoint with username/password validation
2. Token generation and refresh logic
3. Session management with Redis
4. Middleware for protected routes
Work only within the ./src/auth directory.</systemPrompt>
<mcpServers>playwright,supabase</mcpServers>
</spawn_parallel_instance>

Example: Spawning a worker to refactor API routes
<spawn_parallel_instance>
<taskId>api-routes-refactor</taskId>
<workspacePath>./src/api/routes</workspacePath>
<systemPrompt>Refactor API route handlers to use async/await consistently and add proper error handling. Work only within ./src/api/routes directory.</systemPrompt>
</spawn_parallel_instance>

**Workspace Isolation Rules**:
- Each worker must have a unique, non-overlapping workspace path
- Workers cannot share the same directory or parent/child relationships
- Example of VALID assignments:
  - Worker 1: ./src/auth
  - Worker 2: ./src/api
  - Worker 3: ./src/utils
- Example of INVALID assignments (conflicts):
  - Worker 1: ./src
  - Worker 2: ./src/auth  (conflict: auth is nested under src)

**Best Practices**:
1. Use descriptive taskIds that indicate the work being done
2. Keep workspace paths focused and isolated (prefer subdirectories)
3. Provide clear, specific system prompts that define scope and objectives
4. Only specify MCP servers that are actually needed for the task
5. Always verify workers spawned successfully before proceeding
`
}
