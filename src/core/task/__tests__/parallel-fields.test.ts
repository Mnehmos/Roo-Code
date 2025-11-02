import { describe, it, expect, beforeEach, vi } from "vitest"
import { Task } from "../Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { ProviderSettings } from "@roo-code/types"

describe("Task parallel execution fields", () => {
	let mockProvider: ClineProvider
	let mockApiConfiguration: ProviderSettings

	beforeEach(() => {
		// Create minimal mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/tmp/test-storage" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		} as any

		// Create minimal mock API configuration
		mockApiConfiguration = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
		} as ProviderSettings
	})

	it("should support optional parallelExecution flag", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			parallelExecution: true,
			startTask: false,
		})

		expect(task.parallelExecution).toBe(true)
	})

	it("should support optional workingDirectory", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			workingDirectory: "/workspace/subdir",
			startTask: false,
		})

		expect(task.workingDirectory).toBe("/workspace/subdir")
	})

	it("should support optional workerType", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			workerType: "orchestrator",
			startTask: false,
		})

		expect(task.workerType).toBe("orchestrator")
	})

	it("should work with all parallel fields together", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			parallelExecution: true,
			workingDirectory: "/workspace/worker1",
			workerType: "worker",
			startTask: false,
		})

		expect(task.parallelExecution).toBe(true)
		expect(task.workingDirectory).toBe("/workspace/worker1")
		expect(task.workerType).toBe("worker")
	})

	it("should work without parallel fields (backward compatibility)", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			startTask: false,
		})

		expect(task.parallelExecution).toBeUndefined()
		expect(task.workingDirectory).toBeUndefined()
		expect(task.workerType).toBeUndefined()
	})

	it("should accept all valid workerType values", () => {
		const workerTypes = ["orchestrator", "worker", "reviewer"]

		workerTypes.forEach((type) => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfiguration,
				task: "Test task",
				workerType: type,
				startTask: false,
			})

			expect(task.workerType).toBe(type)
		})
	})

	it("should allow custom workerType values (for extensibility)", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			workerType: "custom-worker-type",
			startTask: false,
		})

		expect(task.workerType).toBe("custom-worker-type")
	})

	it("should handle boolean false for parallelExecution", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			parallelExecution: false,
			startTask: false,
		})

		expect(task.parallelExecution).toBe(false)
	})

	it("should handle empty string for workingDirectory", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			workingDirectory: "",
			startTask: false,
		})

		expect(task.workingDirectory).toBe("")
	})

	it("should handle empty string for workerType", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			workerType: "",
			startTask: false,
		})

		expect(task.workerType).toBe("")
	})
})
