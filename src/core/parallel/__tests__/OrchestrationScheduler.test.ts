/**
 * Unit tests for OrchestrationScheduler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	OrchestrationScheduler,
	TaskGraph,
	MaxParallelStrategy,
	RateAwareStrategy,
	CriticalPathStrategy,
	type TaskWithDependencies,
	type SchedulerOptions,
} from "../OrchestrationScheduler"
import type { ParallelInstanceManager } from "../ParallelInstanceManager"
import type { IPCChannel } from "../IPCChannel"

describe("TaskGraph", () => {
	describe("construction and validation", () => {
		it("should build graph from task list", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["A"], instructions: "Task C", workspacePath: "/c" },
			]

			const graph = new TaskGraph(tasks)

			expect(graph.getTaskCount()).toBe(3)
			expect(graph.getCompletedCount()).toBe(0)
		})

		it("should detect circular dependencies", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: ["B"], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["C"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["A"], instructions: "Task C", workspacePath: "/c" },
			]

			expect(() => new TaskGraph(tasks)).toThrow("Circular dependency detected")
		})

		it("should detect self-referencing dependencies", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: ["A"], instructions: "Task A", workspacePath: "/a" },
			]

			expect(() => new TaskGraph(tasks)).toThrow("Circular dependency detected")
		})

		it("should throw error for non-existent dependency", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: ["B"], instructions: "Task A", workspacePath: "/a" },
			]

			expect(() => new TaskGraph(tasks)).toThrow("depends on non-existent task")
		})
	})

	describe("getIndependentTasks", () => {
		it("should identify tasks with no dependencies", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: [], instructions: "Task C", workspacePath: "/c" },
			]

			const graph = new TaskGraph(tasks)
			const independent = graph.getIndependentTasks()

			expect(independent).toContain("A")
			expect(independent).toContain("C")
			expect(independent).not.toContain("B")
			expect(independent).toHaveLength(2)
		})

		it("should update independent tasks after completion", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
			]

			const graph = new TaskGraph(tasks)

			// Initially only A is independent
			let independent = graph.getIndependentTasks()
			expect(independent).toEqual(["A"])

			// After A completes, B becomes independent
			graph.markCompleted("A")
			independent = graph.getIndependentTasks()
			expect(independent).toEqual(["B"])
		})

		it("should handle complex dependency chains", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["A"], instructions: "Task C", workspacePath: "/c" },
				{ id: "D", dependencies: ["B", "C"], instructions: "Task D", workspacePath: "/d" },
			]

			const graph = new TaskGraph(tasks)

			// Step 1: Only A is independent
			expect(graph.getIndependentTasks()).toEqual(["A"])

			// Step 2: After A, both B and C are independent
			graph.markCompleted("A")
			const step2 = graph.getIndependentTasks()
			expect(step2).toContain("B")
			expect(step2).toContain("C")
			expect(step2).toHaveLength(2)

			// Step 3: After B (but not C), D is still waiting
			graph.markCompleted("B")
			expect(graph.getIndependentTasks()).toEqual(["C"])

			// Step 4: After both B and C, D becomes independent
			graph.markCompleted("C")
			expect(graph.getIndependentTasks()).toEqual(["D"])
		})
	})

	describe("getCriticalPath", () => {
		it("should identify longest dependency chain", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["B"], instructions: "Task C", workspacePath: "/c" },
				{ id: "D", dependencies: ["A"], instructions: "Task D", workspacePath: "/d" },
			]

			const graph = new TaskGraph(tasks)
			const criticalPath = graph.getCriticalPath()

			// Critical path should be A -> B -> C (longest chain)
			expect(criticalPath).toEqual(["A", "B", "C"])
		})

		it("should handle multiple equal-length paths", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["A"], instructions: "Task C", workspacePath: "/c" },
			]

			const graph = new TaskGraph(tasks)
			const criticalPath = graph.getCriticalPath()

			// Should return one of the paths (both are equal length)
			expect(criticalPath).toHaveLength(2)
			expect(criticalPath[0]).toBe("A")
		})

		it("should update critical path after completions", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["B"], instructions: "Task C", workspacePath: "/c" },
			]

			const graph = new TaskGraph(tasks)

			// Initial critical path
			expect(graph.getCriticalPath()).toEqual(["A", "B", "C"])

			// After completing A
			graph.markCompleted("A")
			expect(graph.getCriticalPath()).toEqual(["B", "C"])

			// After completing B
			graph.markCompleted("B")
			expect(graph.getCriticalPath()).toEqual(["C"])
		})

		it("should return empty array when all tasks complete", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
			]

			const graph = new TaskGraph(tasks)
			graph.markCompleted("A")

			expect(graph.getCriticalPath()).toEqual([])
		})
	})

	describe("completion tracking", () => {
		it("should track completed tasks", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: [], instructions: "Task B", workspacePath: "/b" },
			]

			const graph = new TaskGraph(tasks)

			expect(graph.allTasksComplete()).toBe(false)
			expect(graph.getCompletedCount()).toBe(0)

			graph.markCompleted("A")
			expect(graph.allTasksComplete()).toBe(false)
			expect(graph.getCompletedCount()).toBe(1)

			graph.markCompleted("B")
			expect(graph.allTasksComplete()).toBe(true)
			expect(graph.getCompletedCount()).toBe(2)
		})

		it("should get task details", () => {
			const tasks: TaskWithDependencies[] = [
				{
					id: "A",
					dependencies: [],
					instructions: "Build auth module",
					workspacePath: "/src/auth",
					workerType: "developer",
					estimatedRPM: 20,
				},
			]

			const graph = new TaskGraph(tasks)
			const details = graph.getTaskDetails("A")

			expect(details).toBeDefined()
			expect(details?.instructions).toBe("Build auth module")
			expect(details?.workspacePath).toBe("/src/auth")
			expect(details?.workerType).toBe("developer")
			expect(details?.estimatedRPM).toBe(20)
		})
	})
})

describe("Scheduling Strategies", () => {
	describe("MaxParallelStrategy", () => {
		it("should spawn all available tasks up to worker limit", () => {
			const strategy = new MaxParallelStrategy()
			const available = ["A", "B", "C", "D", "E"]

			// With 3 workers
			const selected = strategy.selectTasks(available, 3)
			expect(selected).toEqual(["A", "B", "C"])
		})

		it("should handle fewer tasks than workers", () => {
			const strategy = new MaxParallelStrategy()
			const available = ["A", "B"]

			// With 5 workers
			const selected = strategy.selectTasks(available, 5)
			expect(selected).toEqual(["A", "B"])
		})

		it("should handle zero workers", () => {
			const strategy = new MaxParallelStrategy()
			const available = ["A", "B", "C"]

			const selected = strategy.selectTasks(available, 0)
			expect(selected).toEqual([])
		})
	})

	describe("RateAwareStrategy", () => {
		it("should respect RPM limits", () => {
			const strategy = new RateAwareStrategy(3800, 15)
			const available = ["A", "B", "C", "D", "E"]

			// Current RPM: 3750, headroom: 50
			// Can spawn: floor(50 / 15) = 3 tasks
			const selected = strategy.selectTasks(available, 10, 3750)
			expect(selected).toHaveLength(3)
		})

		it("should spawn nothing when at rate limit", () => {
			const strategy = new RateAwareStrategy(3800, 15)
			const available = ["A", "B", "C"]

			// At rate limit
			const selected = strategy.selectTasks(available, 10, 3800)
			expect(selected).toEqual([])
		})

		it("should spawn nothing when over rate limit", () => {
			const strategy = new RateAwareStrategy(3800, 15)
			const available = ["A", "B", "C"]

			// Over rate limit
			const selected = strategy.selectTasks(available, 10, 4000)
			expect(selected).toEqual([])
		})

		it("should respect worker limits even with RPM headroom", () => {
			const strategy = new RateAwareStrategy(3800, 15)
			const available = ["A", "B", "C", "D", "E"]

			// Low RPM (0), but only 2 workers
			const selected = strategy.selectTasks(available, 2, 0)
			expect(selected).toHaveLength(2)
		})

		it("should use default RPM when not provided", () => {
			const strategy = new RateAwareStrategy(3800, 15)
			const available = ["A", "B", "C", "D", "E"]

			// Should assume currentRPM = 0
			const selected = strategy.selectTasks(available, 3)
			expect(selected).toHaveLength(3)
		})
	})

	describe("CriticalPathStrategy", () => {
		it("should prioritize tasks on critical path", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["B"], instructions: "Task C", workspacePath: "/c" },
				{ id: "D", dependencies: ["A"], instructions: "Task D", workspacePath: "/d" },
			]

			const graph = new TaskGraph(tasks)
			graph.markCompleted("A")

			const strategy = new CriticalPathStrategy()
			const available = ["B", "D"] // Both available after A

			// B is on critical path (A->B->C), D is not
			const selected = strategy.selectTasks(available, 1, undefined, graph)
			expect(selected).toEqual(["B"])
		})

		it("should fallback to max-parallel without graph", () => {
			const strategy = new CriticalPathStrategy()
			const available = ["A", "B", "C"]

			const selected = strategy.selectTasks(available, 2)
			expect(selected).toEqual(["A", "B"])
		})

		it("should maintain critical path order", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: ["B"], instructions: "Task C", workspacePath: "/c" },
				{ id: "D", dependencies: ["C"], instructions: "Task D", workspacePath: "/d" },
			]

			const graph = new TaskGraph(tasks)
			graph.markCompleted("A")
			graph.markCompleted("B")

			const strategy = new CriticalPathStrategy()
			const available = ["C"]

			const selected = strategy.selectTasks(available, 2, undefined, graph)
			expect(selected).toEqual(["C"])
		})
	})
})

describe("OrchestrationScheduler Integration", () => {
	let mockInstanceManager: ParallelInstanceManager
	let mockIPC: IPCChannel

	beforeEach(() => {
		// Mock ParallelInstanceManager
		mockInstanceManager = {
			spawnWorker: vi.fn().mockResolvedValue({
				id: "worker-1",
				task: {},
				workingDir: "/test",
				createdAt: new Date(),
				status: "idle",
			}),
		} as any

		// Mock IPCChannel
		mockIPC = {
			send: vi.fn().mockResolvedValue(undefined),
			onMessageType: vi.fn(),
			on: vi.fn(),
			emit: vi.fn(),
		} as any
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe("construction", () => {
		it("should initialize with tasks and options", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
			]

			const options: SchedulerOptions = {
				strategy: "max-parallel",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
			}

			const scheduler = new OrchestrationScheduler(tasks, options)

			const progress = scheduler.getProgress()
			expect(progress.total).toBe(1)
			expect(progress.pending).toBe(1)
		})

		it("should throw error for invalid circular dependencies", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: ["B"], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
			]

			const options: SchedulerOptions = {
				strategy: "max-parallel",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
			}

			expect(() => new OrchestrationScheduler(tasks, options)).toThrow("Circular dependency")
		})
	})

	describe("task assignment", () => {
		it("should spawn worker and send IPC message", async () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Build feature", workspacePath: "/src" },
			]

			const options: SchedulerOptions = {
				strategy: "max-parallel",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
			}

			const scheduler = new OrchestrationScheduler(tasks, options)

			// Trigger start (will assign task A)
			const startPromise = scheduler.start()

			// Wait a bit for async operations
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify worker was spawned
			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith({
				taskId: "A",
				workingDir: "/src",
				systemPrompt: "Build feature",
			})

			// Verify IPC message was sent
			expect(mockIPC.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "task-assignment",
					from: "orchestrator",
					to: "worker-1",
					payload: expect.objectContaining({
						taskId: "A",
						instructions: "Build feature",
					}),
				}),
			)

			// Emit completion to unblock
			const handlers = (mockIPC.onMessageType as any).mock.calls
			const completionHandler = handlers.find((call: any) => call[0] === "task-completed")?.[1]
			if (completionHandler) {
				completionHandler({
					type: "task-completed",
					from: "worker-1",
					to: "orchestrator",
					payload: { taskId: "A" },
					id: "msg-1",
					timestamp: Date.now(),
				})
			}

			await startPromise
		})
	})

	describe("progress tracking", () => {
		it("should track execution progress", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
				{ id: "B", dependencies: ["A"], instructions: "Task B", workspacePath: "/b" },
				{ id: "C", dependencies: [], instructions: "Task C", workspacePath: "/c" },
			]

			const options: SchedulerOptions = {
				strategy: "max-parallel",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
			}

			const scheduler = new OrchestrationScheduler(tasks, options)

			const progress = scheduler.getProgress()
			expect(progress.total).toBe(3)
			expect(progress.pending).toBe(3)
			expect(progress.running).toBe(0)
			expect(progress.completed).toBe(0)
			expect(progress.failed).toBe(0)
		})

		it("should update RPM estimates", () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a", estimatedRPM: 25 },
			]

			const options: SchedulerOptions = {
				strategy: "rate-aware",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
				estimatedRPMPerTask: 15,
			}

			const scheduler = new OrchestrationScheduler(tasks, options)

			expect(scheduler.getCurrentRPM()).toBe(0)
		})
	})

	describe("event handling", () => {
		it("should emit events during execution", async () => {
			const tasks: TaskWithDependencies[] = [
				{ id: "A", dependencies: [], instructions: "Task A", workspacePath: "/a" },
			]

			const options: SchedulerOptions = {
				strategy: "max-parallel",
				instanceManager: mockInstanceManager,
				ipc: mockIPC,
			}

			const scheduler = new OrchestrationScheduler(tasks, options)

			const events: string[] = []
			scheduler.on("started", () => events.push("started"))
			scheduler.on("task-assigned", () => events.push("task-assigned"))
			scheduler.on("completed", () => events.push("completed"))

			const startPromise = scheduler.start()

			// Wait for async operations
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Simulate completion
			const handlers = (mockIPC.onMessageType as any).mock.calls
			const completionHandler = handlers.find((call: any) => call[0] === "task-completed")?.[1]
			if (completionHandler) {
				completionHandler({
					type: "task-completed",
					from: "worker-1",
					to: "orchestrator",
					payload: { taskId: "A" },
					id: "msg-1",
					timestamp: Date.now(),
				})
			}

			await startPromise

			expect(events).toContain("started")
			expect(events).toContain("task-assigned")
			expect(events).toContain("completed")
		})
	})
})
