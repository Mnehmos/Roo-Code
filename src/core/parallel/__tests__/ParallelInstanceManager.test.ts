/**
 * Unit tests for ParallelInstanceManager
 *
 * Tests worker pool management, lifecycle, and resource cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ParallelInstanceManager } from "../ParallelInstanceManager"
import { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { ExtensionContext } from "vscode"
import { RooCodeEventName } from "@roo-code/types"

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../webview/ClineProvider")

describe("ParallelInstanceManager", () => {
	let manager: ParallelInstanceManager
	let mockContext: ExtensionContext
	let mockProvider: ClineProvider
	let mockApiConfiguration: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Create mock context
		mockContext = {
			globalStorageUri: { fsPath: "/mock/storage" },
		} as any

		// Create mock provider
		mockProvider = {
			context: mockContext,
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
		} as any

		// Create mock API configuration
		mockApiConfiguration = {
			apiProvider: "anthropic",
			apiModelId: "claude-sonnet-4",
		}

		// Mock Task constructor to return a mock task with event emitter
		vi.mocked(Task).mockImplementation(() => {
			const mockTask = {
				taskId: `mock-task-${Math.random()}`,
				abort: false,
				on: vi.fn(),
				off: vi.fn(),
				emit: vi.fn(),
			}
			return mockTask as any
		})

		// Create manager instance
		manager = new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, {
			maxWorkers: 5,
			spawnTimeout: 1000,
			autoCleanup: true,
		})
	})

	afterEach(async () => {
		// Clean up after each test
		await manager.cleanup()
	})

	describe("Constructor", () => {
		it("should create manager with default config", () => {
			const defaultManager = new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration)
			expect(defaultManager).toBeDefined()
		})

		it("should validate maxWorkers range (min 2)", () => {
			expect(() => {
				new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, { maxWorkers: 1 })
			}).toThrow("maxWorkers must be between 2 and 50")
		})

		it("should validate maxWorkers range (max 50)", () => {
			expect(() => {
				new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, { maxWorkers: 51 })
			}).toThrow("maxWorkers must be between 2 and 50")
		})

		it("should accept valid maxWorkers values", () => {
			expect(() => {
				new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, { maxWorkers: 2 })
			}).not.toThrow()

			expect(() => {
				new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, { maxWorkers: 50 })
			}).not.toThrow()
		})
	})

	describe("Worker Spawning", () => {
		it("should spawn a single worker successfully", async () => {
			const worker = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src/auth",
				systemPrompt: "Implement auth module",
			})

			expect(worker).toBeDefined()
			expect(worker.id).toBe("worker-1")
			expect(worker.workingDir).toBe("./src/auth")
			expect(worker.status).toBe("idle")
			expect(worker.task).toBeDefined()
			expect(worker.createdAt).toBeInstanceOf(Date)
		})

		it("should spawn multiple workers (2-3 workers)", async () => {
			const worker1 = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src/auth",
				systemPrompt: "Implement auth",
			})

			const worker2 = await manager.spawnWorker({
				taskId: "worker-2",
				workingDir: "./src/api",
				systemPrompt: "Implement API",
			})

			const worker3 = await manager.spawnWorker({
				taskId: "worker-3",
				workingDir: "./src/ui",
				systemPrompt: "Implement UI",
			})

			expect(worker1.id).toBe("worker-1")
			expect(worker2.id).toBe("worker-2")
			expect(worker3.id).toBe("worker-3")

			// Verify all have different workspace paths
			expect(worker1.workingDir).not.toBe(worker2.workingDir)
			expect(worker2.workingDir).not.toBe(worker3.workingDir)

			// Verify Task constructor was called 3 times
			expect(Task).toHaveBeenCalledTimes(3)
		})

		it("should enforce max workers limit", async () => {
			// Spawn max workers (5)
			for (let i = 0; i < 5; i++) {
				await manager.spawnWorker({
					taskId: `worker-${i}`,
					workingDir: `./src/module${i}`,
					systemPrompt: `Module ${i}`,
				})
			}

			// Try to spawn one more - should fail
			await expect(
				manager.spawnWorker({
					taskId: "worker-6",
					workingDir: "./src/overflow",
					systemPrompt: "Overflow",
				}),
			).rejects.toThrow("Maximum worker limit reached (5)")
		})

		it("should reject duplicate worker IDs", async () => {
			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src/auth",
				systemPrompt: "Auth module",
			})

			await expect(
				manager.spawnWorker({
					taskId: "worker-1",
					workingDir: "./src/other",
					systemPrompt: "Other",
				}),
			).rejects.toThrow("Worker with ID worker-1 already exists")
		})

		it("should handle spawn timeout", async () => {
			// Create a manager with very short timeout
			const fastTimeoutManager = new ParallelInstanceManager(mockContext, mockProvider, mockApiConfiguration, {
				spawnTimeout: 10,
			})

			// Mock Task to take longer than timeout
			vi.mocked(Task).mockImplementation(() => {
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							taskId: "slow-task",
							abort: false,
							on: vi.fn(),
							off: vi.fn(),
							emit: vi.fn(),
						} as any)
					}, 100)
				}) as any
			})

			await expect(
				fastTimeoutManager.spawnWorker({
					taskId: "slow-worker",
					workingDir: "./src",
					systemPrompt: "Slow task",
				}),
			).rejects.toThrow("Worker spawn timeout after 10ms")

			await fastTimeoutManager.cleanup()
		})

		it("should pass workspace isolation to Task", async () => {
			const workingDir = "./src/auth"
			const systemPrompt = "Implement auth"

			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir,
				systemPrompt,
			})

			// Verify Task was called with correct workspace path
			expect(Task).toHaveBeenCalledWith(
				expect.objectContaining({
					workspacePath: workingDir,
					task: systemPrompt,
					provider: mockProvider,
					apiConfiguration: mockApiConfiguration,
					enableDiff: true,
					enableCheckpoints: true,
					enableBridge: false,
					startTask: false,
				}),
			)
		})

		it("should set up event listeners on spawned tasks", async () => {
			const worker = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			// Verify event listeners were registered
			expect(worker.task.on).toHaveBeenCalledWith(RooCodeEventName.TaskStarted, expect.any(Function))
			expect(worker.task.on).toHaveBeenCalledWith(RooCodeEventName.TaskCompleted, expect.any(Function))
			expect(worker.task.on).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, expect.any(Function))
			expect(worker.task.on).toHaveBeenCalledWith(RooCodeEventName.TaskToolFailed, expect.any(Function))
		})
	})

	describe("Worker State Tracking", () => {
		it("should track worker status changes", async () => {
			const worker = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			expect(worker.status).toBe("idle")

			// Get the TaskStarted event handler and trigger it
			const onCalls = vi.mocked(worker.task.on).mock.calls
			const taskStartedCall = onCalls.find((call: any) => call[0] === RooCodeEventName.TaskStarted)
			if (taskStartedCall && taskStartedCall[1]) {
				;(taskStartedCall[1] as Function)()
			}

			// Check status updated
			const updatedWorker = manager.getWorker("worker-1")
			expect(updatedWorker?.status).toBe("busy")
		})

		it("should return worker by ID", async () => {
			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			const worker = manager.getWorker("worker-1")
			expect(worker).toBeDefined()
			expect(worker?.id).toBe("worker-1")
		})

		it("should return undefined for non-existent worker", () => {
			const worker = manager.getWorker("non-existent")
			expect(worker).toBeUndefined()
		})

		it("should get worker status", async () => {
			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			const status = manager.getWorkerStatus("worker-1")
			expect(status).toBe("idle")
		})

		it("should return undefined status for non-existent worker", () => {
			const status = manager.getWorkerStatus("non-existent")
			expect(status).toBeUndefined()
		})

		it("should get all active workers", async () => {
			// Spawn 3 workers
			const w1 = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src1",
				systemPrompt: "Test 1",
			})

			const w2 = await manager.spawnWorker({
				taskId: "worker-2",
				workingDir: "./src2",
				systemPrompt: "Test 2",
			})

			await manager.spawnWorker({
				taskId: "worker-3",
				workingDir: "./src3",
				systemPrompt: "Test 3",
			})

			// Simulate w1 and w2 becoming busy
			const onCalls1 = vi.mocked(w1.task.on).mock.calls
			const taskStartedCall1 = onCalls1.find((call: any) => call[0] === RooCodeEventName.TaskStarted)
			if (taskStartedCall1 && taskStartedCall1[1]) {
				;(taskStartedCall1[1] as Function)()
			}

			const onCalls2 = vi.mocked(w2.task.on).mock.calls
			const taskStartedCall2 = onCalls2.find((call: any) => call[0] === RooCodeEventName.TaskStarted)
			if (taskStartedCall2 && taskStartedCall2[1]) {
				;(taskStartedCall2[1] as Function)()
			}

			const activeWorkers = manager.getActiveWorkers()
			expect(activeWorkers).toHaveLength(2)
			expect(activeWorkers.map((w) => w.id).sort()).toEqual(["worker-1", "worker-2"])
		})
	})

	describe("Worker Cleanup", () => {
		it("should terminate a single worker", async () => {
			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			await manager.terminateWorker("worker-1")

			const worker = manager.getWorker("worker-1")
			expect(worker).toBeUndefined()
		})

		it("should handle terminating non-existent worker gracefully", async () => {
			await expect(manager.terminateWorker("non-existent")).resolves.not.toThrow()
		})

		it("should set abort flag when terminating", async () => {
			const worker = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			expect(worker.task.abort).toBe(false)

			await manager.terminateWorker("worker-1")

			expect(worker.task.abort).toBe(true)
		})

		it("should clean up all workers", async () => {
			// Spawn 3 workers
			await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src1",
				systemPrompt: "Test 1",
			})

			await manager.spawnWorker({
				taskId: "worker-2",
				workingDir: "./src2",
				systemPrompt: "Test 2",
			})

			await manager.spawnWorker({
				taskId: "worker-3",
				workingDir: "./src3",
				systemPrompt: "Test 3",
			})

			await manager.cleanup()

			expect(manager.getWorker("worker-1")).toBeUndefined()
			expect(manager.getWorker("worker-2")).toBeUndefined()
			expect(manager.getWorker("worker-3")).toBeUndefined()
		})

		it("should handle cleanup errors gracefully", async () => {
			const worker = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src",
				systemPrompt: "Test",
			})

			// Make worker.task.abort throw an error
			Object.defineProperty(worker.task, "abort", {
				set: () => {
					throw new Error("Abort failed")
				},
			})

			// Should not throw, but log error
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await manager.cleanup()

			consoleErrorSpy.mockRestore()
		})

		it("should dispose manager", () => {
			manager.dispose()
			// Should clear workers map
			expect(manager.getActiveWorkers()).toHaveLength(0)
		})
	})

	describe("Wait for Completion", () => {
		it("should wait for all workers to complete", async () => {
			const worker1 = await manager.spawnWorker({
				taskId: "worker-1",
				workingDir: "./src1",
				systemPrompt: "Test 1",
			})

			const worker2 = await manager.spawnWorker({
				taskId: "worker-2",
				workingDir: "./src2",
				systemPrompt: "Test 2",
			})

			// Start workers
			const onCalls1 = vi.mocked(worker1.task.on).mock.calls
			const taskStartedCall1 = onCalls1.find((call: any) => call[0] === RooCodeEventName.TaskStarted)
			if (taskStartedCall1 && taskStartedCall1[1]) {
				;(taskStartedCall1[1] as Function)()
			}

			const onCalls2 = vi.mocked(worker2.task.on).mock.calls
			const taskStartedCall2 = onCalls2.find((call: any) => call[0] === RooCodeEventName.TaskStarted)
			if (taskStartedCall2 && taskStartedCall2[1]) {
				;(taskStartedCall2[1] as Function)()
			}

			// Simulate completion after a delay
			setTimeout(() => {
				const taskCompletedCall1 = onCalls1.find((call: any) => call[0] === RooCodeEventName.TaskCompleted)
				if (taskCompletedCall1 && taskCompletedCall1[1]) {
					;(taskCompletedCall1[1] as Function)()
				}

				const taskCompletedCall2 = onCalls2.find((call: any) => call[0] === RooCodeEventName.TaskCompleted)
				if (taskCompletedCall2 && taskCompletedCall2[1]) {
					;(taskCompletedCall2[1] as Function)()
				}
			}, 50)

			await manager.waitForAll()

			// All workers should be idle
			expect(manager.getWorker("worker-1")?.status).toBe("idle")
			expect(manager.getWorker("worker-2")?.status).toBe("idle")
		})

		it("should return immediately when no workers exist", async () => {
			await expect(manager.waitForAll()).resolves.not.toThrow()
		})
	})

	describe("Edge Cases", () => {
		it("should handle rapid spawn/terminate cycles", async () => {
			for (let i = 0; i < 10; i++) {
				const worker = await manager.spawnWorker({
					taskId: `worker-${i}`,
					workingDir: `./src${i}`,
					systemPrompt: `Test ${i}`,
				})

				await manager.terminateWorker(worker.id)
			}

			expect(manager.getActiveWorkers()).toHaveLength(0)
		})

		it("should handle concurrent spawns", async () => {
			const spawnPromises = [
				manager.spawnWorker({
					taskId: "worker-1",
					workingDir: "./src1",
					systemPrompt: "Test 1",
				}),
				manager.spawnWorker({
					taskId: "worker-2",
					workingDir: "./src2",
					systemPrompt: "Test 2",
				}),
				manager.spawnWorker({
					taskId: "worker-3",
					workingDir: "./src3",
					systemPrompt: "Test 3",
				}),
			]

			const workers = await Promise.all(spawnPromises)

			expect(workers).toHaveLength(3)
			expect(workers[0].id).toBe("worker-1")
			expect(workers[1].id).toBe("worker-2")
			expect(workers[2].id).toBe("worker-3")
		})
	})
})
