// npx vitest core/tools/__tests__/spawnParallelInstanceTool.spec.ts

import type { AskApproval, HandleError } from "../../../shared/tools"
import type { WorkerInstance } from "../../parallel/ParallelInstanceManager"

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock ParallelInstanceManager
vi.mock("../../parallel/ParallelInstanceManager", () => ({
	ParallelInstanceManager: vi.fn().mockImplementation(() => ({
		spawnWorker: vi.fn(),
	})),
}))

// Mock WorkspaceAnalyzer
vi.mock("../../parallel/WorkspaceAnalyzer", () => ({
	WorkspaceAnalyzer: vi.fn().mockImplementation(() => ({
		validateAssignments: vi.fn(() => ({
			isValid: true,
			conflicts: [],
			assignments: new Map(),
		})),
	})),
}))

// Mock formatResponse
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Tool Result: ${msg}`),
	},
}))

// Mock dependencies after modules are mocked
const mockAskApproval = vi.fn<AskApproval>()
const mockHandleError = vi.fn<HandleError>()
const mockPushToolResult = vi.fn()
const mockRemoveClosingTag = vi.fn((_name: string, value: string | undefined) => value ?? "")
const mockRecordToolError = vi.fn()
const mockSayAndCreateMissingParamError = vi.fn()

// Mock the Task instance
const mockTask = {
	ask: vi.fn(),
	sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
	recordToolError: mockRecordToolError,
	consecutiveMistakeCount: 0,
	providerRef: {
		deref: vi.fn(() => ({
			getState: vi.fn(() =>
				Promise.resolve({
					customModes: [],
					mode: "orchestrator",
					apiConfiguration: {},
				}),
			),
			cwd: "/test/project/root",
			context: { globalStoragePath: "/test/storage" },
		})),
	},
}

// Import the function to test AFTER mocks are set up
import { spawnParallelInstanceTool } from "../spawnParallelInstanceTool"
import type { ToolUse } from "../../../shared/tools"
import { ParallelInstanceManager } from "../../parallel/ParallelInstanceManager"
import { formatResponse } from "../../prompts/responses"

describe("spawnParallelInstanceTool", () => {
	let mockManager: any

	beforeEach(() => {
		// Reset mocks before each test
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true) // Default to approved
		mockTask.consecutiveMistakeCount = 0

		// Create mock manager instance
		mockManager = {
			spawnWorker: vi.fn(),
		}
		vi.mocked(ParallelInstanceManager).mockImplementation(() => mockManager)
	})

	describe("Parameter Validation", () => {
		it("should error when taskId parameter is missing", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					// taskId missing
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("spawn_parallel_instance", "taskId")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("spawn_parallel_instance")
		})

		it("should error when workspacePath parameter is missing", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					// workspacePath missing
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("spawn_parallel_instance", "workspacePath")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("spawn_parallel_instance")
		})

		it("should error when systemPrompt parameter is missing", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					// systemPrompt missing
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("spawn_parallel_instance", "systemPrompt")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("spawn_parallel_instance")
		})
	})

	describe("Successful Worker Spawning", () => {
		it("should spawn worker with valid parameters", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Implement authentication module",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith({
				taskId: "test-task-1",
				workingDir: expect.stringMatching(/src[\\\/]auth$/),
				systemPrompt: "Implement authentication module",
				mcpServers: [],
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully spawned parallel worker instance"),
			)
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Worker ID: test-task-1"))
			expect(mockTask.consecutiveMistakeCount).toBe(0)
		})

		it("should parse mcpServers from JSON array string", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
					mcpServers: '["playwright","github"]',
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					mcpServers: ["playwright", "github"],
				}),
			)
		})

		it("should parse mcpServers from comma-separated string", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
					mcpServers: "playwright, github, supabase",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					mcpServers: ["playwright", "github", "supabase"],
				}),
			)
		})

		it("should convert relative path to absolute path", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					workingDir: expect.stringMatching(/src[\\\/]auth$/),
				}),
			)
		})
	})

	describe("Error Handling", () => {
		it("should handle spawn errors gracefully", async () => {
			mockManager.spawnWorker.mockRejectedValue(new Error("Failed to spawn worker: max workers exceeded"))

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("spawn_parallel_instance")
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Failed to spawn parallel worker"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("max workers exceeded"))
		})

		it("should handle provider reference lost error", async () => {
			const taskWithNoProvider = {
				...mockTask,
				providerRef: {
					deref: vi.fn(() => undefined),
				},
			}

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				taskWithNoProvider as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(vi.mocked(formatResponse.toolError)).toHaveBeenCalledWith("Provider reference lost")
		})
	})

	describe("Approval Flow", () => {
		it("should request approval before spawning", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Implement authentication module with JWT",
					mcpServers: "playwright,github",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockAskApproval).toHaveBeenCalledWith("tool", expect.stringContaining("spawn_parallel_instance"))
			expect(mockAskApproval).toHaveBeenCalledWith("tool", expect.stringContaining("test-task-1"))
		})

		it("should not spawn worker if approval is denied", async () => {
			mockAskApproval.mockResolvedValue(false) // Deny approval

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("Partial Streaming", () => {
		it("should handle partial tool use during streaming", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Partial prompt...",
				},
				partial: true, // Streaming not complete
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			// Should call ask with partial message
			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("spawn_parallel_instance"), true)

			// Should NOT spawn worker during streaming
			expect(mockManager.spawnWorker).not.toHaveBeenCalled()
		})
	})

	describe("MCP Server Handling", () => {
		it("should handle empty mcpServers parameter", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
					// mcpServers not provided
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					mcpServers: [],
				}),
			)
		})

		it("should filter out empty server names from comma-separated list", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
					mcpServers: "playwright, , github, ,supabase",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					mcpServers: ["playwright", "github", "supabase"],
				}),
			)
		})
	})

	describe("System Prompt Truncation", () => {
		it("should truncate long system prompts in approval message", async () => {
			const longPrompt = "A".repeat(200) // 200 character prompt

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: longPrompt,
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			// Approval message should contain truncated prompt (100 chars + ...)
			expect(mockAskApproval).toHaveBeenCalledWith("tool", expect.stringContaining("A".repeat(100) + "..."))
		})

		it("should not truncate short system prompts", async () => {
			const shortPrompt = "Short prompt"

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: shortPrompt,
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			// Approval message should contain full prompt without "..."
			const approvalCall = mockAskApproval.mock.calls[0][1]
			expect(approvalCall).toContain(shortPrompt)
			expect(approvalCall).not.toContain("...")
		})
	})

	describe("Result Reporting", () => {
		it("should report worker metadata in result", async () => {
			const mockWorker: WorkerInstance = {
				id: "auth-worker-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "auth-impl-1",
					workspacePath: "./src/auth",
					systemPrompt: "Implement JWT auth",
					mcpServers: '["playwright","supabase"]',
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			const resultCall = mockPushToolResult.mock.calls[0][0]
			expect(resultCall).toContain("Worker ID: auth-worker-1")
			expect(resultCall).toContain("Task ID: auth-impl-1")
			expect(resultCall).toMatch(/Workspace:.*src[\\\/]auth/)
			expect(resultCall).toContain("MCP Servers: playwright, supabase")
			expect(resultCall).toContain("Status: idle")
		})

		it("should report 'none' for MCP servers when not provided", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			const resultCall = mockPushToolResult.mock.calls[0][0]
			expect(resultCall).toContain("MCP Servers: none")
		})
	})

	describe("Edge Cases", () => {
		it("should handle absolute workspace paths", async () => {
			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/absolute/path/to/workspace",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "/absolute/path/to/workspace",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					workingDir: "/absolute/path/to/workspace",
				}),
			)
		})

		it("should reset consecutive mistake count on success", async () => {
			mockTask.consecutiveMistakeCount = 5

			const mockWorker: WorkerInstance = {
				id: "test-task-1",
				task: {} as any,
				workingDir: "/test/project/root/src/auth",
				createdAt: new Date(),
				status: "idle",
			}

			mockManager.spawnWorker.mockResolvedValue(mockWorker)

			const block: ToolUse = {
				type: "tool_use",
				name: "spawn_parallel_instance",
				params: {
					taskId: "test-task-1",
					workspacePath: "./src/auth",
					systemPrompt: "Test prompt",
				},
				partial: false,
			}

			await spawnParallelInstanceTool(
				mockTask as any,
				block,
				mockAskApproval,
				mockHandleError,
				mockPushToolResult,
				mockRemoveClosingTag,
			)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
		})
	})
})
