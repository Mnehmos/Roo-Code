import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { ParallelInstanceManager } from "../parallel/ParallelInstanceManager"
import { WorkspaceAnalyzer } from "../parallel/WorkspaceAnalyzer"
import path from "path"

export async function spawnParallelInstanceTool(
	task: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const taskId: string | undefined = block.params.taskId
	const workspacePath: string | undefined = block.params.workspacePath
	const systemPrompt: string | undefined = block.params.systemPrompt
	const mcpServers: string | undefined = block.params.mcpServers

	try {
		if (block.partial) {
			const partialMessage = JSON.stringify({
				tool: "spawn_parallel_instance",
				taskId: removeClosingTag("taskId", taskId),
				workspacePath: removeClosingTag("workspacePath", workspacePath),
				systemPrompt: removeClosingTag("systemPrompt", systemPrompt),
				mcpServers: removeClosingTag("mcpServers", mcpServers),
			})

			await task.ask("tool", partialMessage, block.partial).catch(() => {})
			return
		} else {
			// Validate required parameters
			if (!taskId) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_parallel_instance")
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_parallel_instance", "taskId"))
				return
			}

			if (!workspacePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_parallel_instance")
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_parallel_instance", "workspacePath"))
				return
			}

			if (!systemPrompt) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_parallel_instance")
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_parallel_instance", "systemPrompt"))
				return
			}

			// Parse mcpServers from comma-separated string to array
			let mcpServerArray: string[] = []
			if (mcpServers) {
				try {
					// Try parsing as JSON array first
					mcpServerArray = JSON.parse(mcpServers)
					if (!Array.isArray(mcpServerArray)) {
						throw new Error("mcpServers must be an array")
					}
				} catch {
					// Fallback to comma-separated string
					mcpServerArray = mcpServers
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				}
			}

			// Get provider reference
			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Normalize workspace path (make it absolute relative to project root)
			const projectRoot = provider.cwd
			const absoluteWorkspacePath = path.isAbsolute(workspacePath)
				? workspacePath
				: path.resolve(projectRoot, workspacePath)

			task.consecutiveMistakeCount = 0

			const toolMessage = JSON.stringify({
				tool: "spawn_parallel_instance",
				taskId,
				workspacePath: absoluteWorkspacePath,
				systemPrompt: systemPrompt.substring(0, 100) + (systemPrompt.length > 100 ? "..." : ""),
				mcpServers: mcpServerArray,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Create ParallelInstanceManager if not exists
			// Note: In production, this should be managed at the provider level
			const apiConfiguration = await provider.getState().then((s) => s.apiConfiguration)
			const context = provider.context

			const manager = new ParallelInstanceManager(context, provider, apiConfiguration, {
				maxWorkers: 10,
				spawnTimeout: 5000,
				autoCleanup: true,
			})

			try {
				// Spawn worker
				const worker = await manager.spawnWorker({
					taskId,
					workingDir: absoluteWorkspacePath,
					systemPrompt,
					mcpServers: mcpServerArray,
				})

				pushToolResult(
					formatResponse.toolResult(
						`Successfully spawned parallel worker instance:\n` +
							`- Worker ID: ${worker.id}\n` +
							`- Task ID: ${taskId}\n` +
							`- Workspace: ${absoluteWorkspacePath}\n` +
							`- MCP Servers: ${mcpServerArray.length > 0 ? mcpServerArray.join(", ") : "none"}\n` +
							`- Status: ${worker.status}`,
					),
				)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_parallel_instance")
				pushToolResult(
					formatResponse.toolError(
						`Failed to spawn parallel worker: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
			}

			return
		}
	} catch (error) {
		await handleError("spawning parallel instance", error)
		return
	}
}
