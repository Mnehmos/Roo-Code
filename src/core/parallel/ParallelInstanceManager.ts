/**
 * ParallelInstanceManager
 *
 * Manages a pool of parallel Task instances for concurrent execution.
 * Handles worker spawning, lifecycle management, and resource cleanup.
 *
 * @module core/parallel
 */

import type { ExtensionContext } from "vscode"
import { Task, type TaskOptions } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { RooCodeEventName, type ProviderSettings } from "@roo-code/types"

/**
 * Configuration options for parallel instance management
 */
export interface ParallelInstanceConfig {
	/** Maximum number of concurrent workers (2-50) */
	maxWorkers: number

	/** Worker spawn timeout in milliseconds */
	spawnTimeout: number

	/** Enable automatic cleanup on errors */
	autoCleanup: boolean

	/** Working directory assignments for workspace isolation */
	workspaceDirs?: Map<string, string>
}

/**
 * Worker instance metadata
 */
export interface WorkerInstance {
	/** Unique worker identifier */
	id: string

	/** Associated Task instance */
	task: Task

	/** Working directory for workspace isolation */
	workingDir: string

	/** Worker spawn timestamp */
	createdAt: Date

	/** Current worker status */
	status: "idle" | "busy" | "error" | "terminated"
}

/**
 * Manages parallel Task instances with resource pooling and lifecycle management
 *
 * Key Responsibilities:
 * - Spawn multiple Task instances with workspace isolation
 * - Track worker pool state and availability
 * - Enforce resource limits (max workers, spawn timeout)
 * - Clean up resources on completion or error
 * - Coordinate with OrchestrationScheduler for task assignment
 *
 * Design Principles:
 * - Reuses existing Task constructor 100% (no modifications)
 * - Leverages ClineProvider initialization patterns
 * - Maintains workspace isolation through directory filtering
 * - Provides clean lifecycle hooks for coordination
 *
 * @example
 * ```typescript
 * const manager = new ParallelInstanceManager(context, provider, apiConfig, {
 *   maxWorkers: 5,
 *   spawnTimeout: 3000,
 *   autoCleanup: true
 * });
 *
 * const worker = await manager.spawnWorker({
 *   taskId: 'task-1',
 *   workingDir: './src/auth',
 *   systemPrompt: 'Implement auth module'
 * });
 *
 * await manager.cleanup();
 * ```
 */
export class ParallelInstanceManager {
	private workers: Map<string, WorkerInstance> = new Map()
	private config: ParallelInstanceConfig
	private readonly provider: ClineProvider
	private readonly apiConfiguration: ProviderSettings

	constructor(
		private readonly context: ExtensionContext,
		provider: ClineProvider,
		apiConfiguration: ProviderSettings,
		config: Partial<ParallelInstanceConfig> = {},
	) {
		// Validate maxWorkers is within allowed range (2-50)
		const maxWorkers = config.maxWorkers ?? 10
		if (maxWorkers < 2 || maxWorkers > 50) {
			throw new Error("maxWorkers must be between 2 and 50")
		}

		this.config = {
			maxWorkers,
			spawnTimeout: config.spawnTimeout ?? 3000,
			autoCleanup: config.autoCleanup ?? true,
			workspaceDirs: config.workspaceDirs,
		}

		this.provider = provider
		this.apiConfiguration = apiConfiguration
	}

	/**
	 * Spawn a new worker Task instance
	 *
	 * @param params - Worker spawn parameters
	 * @returns Worker instance metadata
	 * @throws Error if max workers exceeded or spawn timeout
	 */
	async spawnWorker(params: {
		taskId: string
		workingDir: string
		systemPrompt: string
		mcpServers?: string[]
	}): Promise<WorkerInstance> {
		// Enforce max workers limit
		if (this.workers.size >= this.config.maxWorkers) {
			throw new Error(`Maximum worker limit reached (${this.config.maxWorkers})`)
		}

		// Check for duplicate worker ID
		if (this.workers.has(params.taskId)) {
			throw new Error(`Worker with ID ${params.taskId} already exists`)
		}

		// Create spawn timeout promise
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Worker spawn timeout after ${this.config.spawnTimeout}ms`))
			}, this.config.spawnTimeout)
		})

		try {
			// Spawn task with timeout handling
			const task = await Promise.race([this.createTask(params), timeoutPromise])

			// Create worker instance metadata
			const worker: WorkerInstance = {
				id: params.taskId,
				task,
				workingDir: params.workingDir,
				createdAt: new Date(),
				status: "idle",
			}

			// Track worker
			this.workers.set(params.taskId, worker)

			// Set up task event listeners for state tracking
			this.setupTaskEventListeners(worker)

			return worker
		} catch (error) {
			// Clean up on spawn failure
			if (this.config.autoCleanup) {
				await this.terminateWorker(params.taskId).catch(() => {
					// Ignore cleanup errors on spawn failure
				})
			}
			throw error
		}
	}

	/**
	 * Create a Task instance with workspace isolation
	 * Reuses 100% of existing Task constructor logic
	 */
	private async createTask(params: {
		taskId: string
		workingDir: string
		systemPrompt: string
		mcpServers?: string[]
	}): Promise<Task> {
		const taskOptions: TaskOptions = {
			provider: this.provider,
			apiConfiguration: this.apiConfiguration,
			task: params.systemPrompt,
			workspacePath: params.workingDir,
			enableDiff: true,
			enableCheckpoints: true,
			enableBridge: false,
			startTask: true, // CRITICAL: Auto-start for autonomous workers
			// CRITICAL: Mark as worker for auto-approval and isolation
			parallelExecution: true,
			workingDirectory: params.workingDir,
			workerType: "worker", // KEY FLAG for auto-approval
		}

		return new Task(taskOptions)
	}

	/**
	 * Set up event listeners to track worker state
	 */
	private setupTaskEventListeners(worker: WorkerInstance): void {
		const task = worker.task

		// Track when task starts working
		task.on(RooCodeEventName.TaskStarted, () => {
			const w = this.workers.get(worker.id)
			if (w) {
				w.status = "busy"
			}
		})

		// Track when task completes
		task.on(RooCodeEventName.TaskCompleted, () => {
			const w = this.workers.get(worker.id)
			if (w) {
				w.status = "idle"
			}
		})

		// Track when task is aborted
		task.on(RooCodeEventName.TaskAborted, () => {
			const w = this.workers.get(worker.id)
			if (w) {
				w.status = "error"
			}
		})

		// Track tool failures as errors
		task.on(RooCodeEventName.TaskToolFailed, () => {
			const w = this.workers.get(worker.id)
			if (w) {
				w.status = "error"
			}
		})
	}

	/**
	 * Terminate a worker and clean up resources
	 */
	async terminateWorker(workerId: string): Promise<void> {
		const worker = this.workers.get(workerId)
		if (!worker) {
			return // Worker doesn't exist, nothing to clean up
		}

		try {
			// Mark as terminated
			worker.status = "terminated"

			// Abort the task gracefully
			worker.task.abort = true

			// Wait a moment for graceful shutdown
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Force disposal if needed
			if (typeof (worker.task as any).dispose === "function") {
				;(worker.task as any).dispose()
			}
		} finally {
			// Always remove from tracking
			this.workers.delete(workerId)
		}
	}

	/**
	 * Get worker status
	 */
	getWorkerStatus(workerId: string): WorkerInstance["status"] | undefined {
		return this.workers.get(workerId)?.status
	}

	/**
	 * Get worker instance by ID
	 */
	getWorker(id: string): WorkerInstance | undefined {
		return this.workers.get(id)
	}

	/**
	 * Get all active workers
	 */
	getActiveWorkers(): WorkerInstance[] {
		return Array.from(this.workers.values()).filter((w) => w.status === "busy")
	}

	/**
	 * Wait for all workers to complete
	 */
	async waitForAll(): Promise<void> {
		const workers = Array.from(this.workers.values())
		if (workers.length === 0) {
			return
		}

		// Create promises for each worker to complete
		const completionPromises = workers.map(async (worker) => {
			// Wait for worker to reach idle or error state
			return new Promise<void>((resolve) => {
				const checkStatus = () => {
					const currentWorker = this.workers.get(worker.id)
					if (
						!currentWorker ||
						currentWorker.status === "idle" ||
						currentWorker.status === "error" ||
						currentWorker.status === "terminated"
					) {
						resolve()
					} else {
						// Check again in 100ms
						setTimeout(checkStatus, 100)
					}
				}
				checkStatus()
			})
		})

		// Wait for all workers to complete
		await Promise.all(completionPromises)
	}

	/**
	 * Clean up all worker resources
	 */
	async cleanup(): Promise<void> {
		const workerIds = Array.from(this.workers.keys())

		// Terminate all workers in parallel
		const terminationPromises = workerIds.map((id) =>
			this.terminateWorker(id).catch((error) => {
				// Log but don't throw - best effort cleanup
				console.error(`Failed to terminate worker ${id}:`, error)
			}),
		)

		await Promise.all(terminationPromises)

		// Ensure all workers are cleared
		this.workers.clear()
	}

	/**
	 * Dispose of manager and all workers
	 */
	dispose(): void {
		this.workers.clear()
	}
}
