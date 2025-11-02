/**
 * OrchestrationScheduler
 *
 * Analyzes task dependencies, decides which tasks can run in parallel,
 * and coordinates their execution using ParallelInstanceManager and IPCChannel.
 *
 * @module core/parallel
 */

import { EventEmitter } from "events"
import type { ParallelInstanceManager, WorkerInstance } from "./ParallelInstanceManager"
import type { IPCChannel, IPCMessage } from "./IPCChannel"

/**
 * Task with dependency information
 */
export interface TaskWithDependencies {
	/** Unique task identifier */
	id: string

	/** Task dependencies (IDs of tasks that must complete first) */
	dependencies: string[]

	/** Task instructions/prompt */
	instructions: string

	/** Working directory for workspace isolation */
	workspacePath: string

	/** Optional worker specialization type */
	workerType?: string

	/** Estimated requests per minute for rate limiting */
	estimatedRPM?: number
}

/**
 * Scheduling strategy type
 */
export type SchedulingStrategyType = "max-parallel" | "rate-aware" | "critical-path"

/**
 * Scheduler configuration options
 */
export interface SchedulerOptions {
	/** Scheduling strategy to use */
	strategy: SchedulingStrategyType

	/** ParallelInstanceManager for worker spawning */
	instanceManager: ParallelInstanceManager

	/** IPCChannel for communication */
	ipc: IPCChannel

	/** Maximum RPM limit for rate-aware strategy */
	maxRPM?: number

	/** Estimated RPM per task (default: 15) */
	estimatedRPMPerTask?: number
}

/**
 * Graph node representing a task
 */
export interface TaskNode {
	id: string
	dependencies: Set<string>
	dependents: Set<string>
	completed: boolean
	instructions: string
	workspacePath: string
	workerType?: string
	estimatedRPM?: number
}

/**
 * Task Graph (Directed Acyclic Graph)
 *
 * Represents tasks as nodes and dependencies as edges.
 * Provides operations for:
 * - Cycle detection
 * - Independent task identification
 * - Critical path calculation
 * - Dynamic updates on completion
 */
export class TaskGraph {
	private nodes: Map<string, TaskNode> = new Map()

	constructor(tasks: TaskWithDependencies[]) {
		this.buildGraph(tasks)
		this.validateNoCycles()
	}

	/**
	 * Build graph from task list
	 */
	private buildGraph(tasks: TaskWithDependencies[]): void {
		// First pass: Create all nodes
		for (const task of tasks) {
			this.nodes.set(task.id, {
				id: task.id,
				dependencies: new Set(task.dependencies),
				dependents: new Set(),
				completed: false,
				instructions: task.instructions,
				workspacePath: task.workspacePath,
				workerType: task.workerType,
				estimatedRPM: task.estimatedRPM,
			})
		}

		// Second pass: Build dependent relationships
		for (const node of this.nodes.values()) {
			for (const depId of node.dependencies) {
				const depNode = this.nodes.get(depId)
				if (!depNode) {
					throw new Error(`Task ${node.id} depends on non-existent task ${depId}`)
				}
				depNode.dependents.add(node.id)
			}
		}
	}

	/**
	 * Validate no circular dependencies using DFS
	 * @throws Error if cycle detected
	 */
	private validateNoCycles(): void {
		const visited = new Set<string>()
		const visiting = new Set<string>()

		const dfs = (nodeId: string, path: string[]): void => {
			if (visiting.has(nodeId)) {
				const cycle = [...path, nodeId].join(" → ")
				throw new Error(`Circular dependency detected: ${cycle}`)
			}

			if (visited.has(nodeId)) {
				return
			}

			visiting.add(nodeId)
			const node = this.nodes.get(nodeId)!

			for (const depId of node.dependencies) {
				dfs(depId, [...path, nodeId])
			}

			visiting.delete(nodeId)
			visited.add(nodeId)
		}

		// Check all nodes for cycles
		for (const nodeId of this.nodes.keys()) {
			if (!visited.has(nodeId)) {
				dfs(nodeId, [])
			}
		}
	}

	/**
	 * Get tasks with no incomplete dependencies (ready to execute)
	 */
	getIndependentTasks(): string[] {
		const independent: string[] = []

		for (const node of this.nodes.values()) {
			if (node.completed) {
				continue
			}

			// Check if all dependencies are completed
			const hasIncompleteDeps = Array.from(node.dependencies).some((depId) => !this.nodes.get(depId)?.completed)

			if (!hasIncompleteDeps) {
				independent.push(node.id)
			}
		}

		return independent
	}

	/**
	 * Calculate critical path (longest path through the graph)
	 * Uses dynamic programming with topological sort
	 */
	getCriticalPath(): string[] {
		// Topological sort using Kahn's algorithm
		const inDegree = new Map<string, number>()
		const queue: string[] = []

		// Initialize in-degrees
		for (const node of this.nodes.values()) {
			if (node.completed) {
				continue
			}

			const incompleteDeps = Array.from(node.dependencies).filter((depId) => !this.nodes.get(depId)?.completed)
			inDegree.set(node.id, incompleteDeps.length)

			if (incompleteDeps.length === 0) {
				queue.push(node.id)
			}
		}

		// Calculate longest paths (critical path)
		const distances = new Map<string, number>()
		const predecessors = new Map<string, string | null>()

		for (const nodeId of this.nodes.keys()) {
			distances.set(nodeId, 0)
			predecessors.set(nodeId, null)
		}

		const sorted: string[] = []

		while (queue.length > 0) {
			const nodeId = queue.shift()!
			sorted.push(nodeId)

			const node = this.nodes.get(nodeId)!

			// Update distances for dependents
			for (const dependentId of node.dependents) {
				const dependent = this.nodes.get(dependentId)!
				if (dependent.completed) {
					continue
				}

				const newDist = distances.get(nodeId)! + 1
				if (newDist > distances.get(dependentId)!) {
					distances.set(dependentId, newDist)
					predecessors.set(dependentId, nodeId)
				}

				// Decrement in-degree
				const degree = inDegree.get(dependentId)! - 1
				inDegree.set(dependentId, degree)

				if (degree === 0) {
					queue.push(dependentId)
				}
			}
		}

		// Find node with maximum distance (end of critical path)
		let maxDist = -1
		let endNode: string | null = null

		for (const [nodeId, dist] of distances.entries()) {
			const node = this.nodes.get(nodeId)!
			if (!node.completed && dist > maxDist) {
				maxDist = dist
				endNode = nodeId
			}
		}

		if (!endNode) {
			return []
		}

		// Reconstruct path
		const path: string[] = []
		let current: string | null = endNode

		while (current !== null) {
			path.unshift(current)
			current = predecessors.get(current)!
		}

		return path
	}

	/**
	 * Mark task as completed and update graph
	 */
	markCompleted(taskId: string): void {
		const node = this.nodes.get(taskId)
		if (node) {
			node.completed = true
		}
	}

	/**
	 * Get task details
	 */
	getTaskDetails(taskId: string): TaskNode | undefined {
		return this.nodes.get(taskId)
	}

	/**
	 * Check if all tasks are complete
	 */
	allTasksComplete(): boolean {
		return Array.from(this.nodes.values()).every((node) => node.completed)
	}

	/**
	 * Get total task count
	 */
	getTaskCount(): number {
		return this.nodes.size
	}

	/**
	 * Get completed task count
	 */
	getCompletedCount(): number {
		return Array.from(this.nodes.values()).filter((n) => n.completed).length
	}
}

/**
 * Base scheduling strategy interface
 */
export interface SchedulingStrategy {
	name: SchedulingStrategyType

	/**
	 * Select which tasks to spawn next
	 * @param availableTasks - Task IDs ready to execute
	 * @param availableWorkers - Number of available worker slots
	 * @param currentRPM - Current requests per minute (for rate-aware)
	 * @param graph - Task graph (for critical-path)
	 * @returns Array of task IDs to spawn
	 */
	selectTasks(availableTasks: string[], availableWorkers: number, currentRPM?: number, graph?: TaskGraph): string[]
}

/**
 * Max-Parallel Strategy
 * Spawns all available tasks up to worker limit
 */
export class MaxParallelStrategy implements SchedulingStrategy {
	name: SchedulingStrategyType = "max-parallel"

	selectTasks(availableTasks: string[], availableWorkers: number): string[] {
		return availableTasks.slice(0, availableWorkers)
	}
}

/**
 * Rate-Aware Strategy
 * Throttles spawning to stay under API rate limits
 */
export class RateAwareStrategy implements SchedulingStrategy {
	name: SchedulingStrategyType = "rate-aware"
	private maxRPM: number
	private estimatedRPMPerTask: number

	constructor(maxRPM: number = 3800, estimatedRPMPerTask: number = 15) {
		this.maxRPM = maxRPM
		this.estimatedRPMPerTask = estimatedRPMPerTask
	}

	selectTasks(availableTasks: string[], availableWorkers: number, currentRPM: number = 0): string[] {
		// Calculate headroom in RPM
		const headroom = Math.max(0, this.maxRPM - currentRPM)

		// Estimate how many tasks we can spawn
		const tasksToSpawn = Math.min(
			availableTasks.length,
			availableWorkers,
			Math.floor(headroom / this.estimatedRPMPerTask),
		)

		return availableTasks.slice(0, tasksToSpawn)
	}
}

/**
 * Critical-Path Strategy
 * Prioritizes tasks on the longest dependency chain
 */
export class CriticalPathStrategy implements SchedulingStrategy {
	name: SchedulingStrategyType = "critical-path"

	selectTasks(availableTasks: string[], availableWorkers: number, currentRPM?: number, graph?: TaskGraph): string[] {
		if (!graph) {
			// Fallback to max-parallel if no graph provided
			return availableTasks.slice(0, availableWorkers)
		}

		const criticalPath = graph.getCriticalPath()

		// Prioritize tasks on critical path
		const prioritized = availableTasks.sort((a, b) => {
			const aOnPath = criticalPath.includes(a)
			const bOnPath = criticalPath.includes(b)

			if (aOnPath && !bOnPath) return -1
			if (!aOnPath && bOnPath) return 1

			// If both on path, maintain critical path order
			if (aOnPath && bOnPath) {
				return criticalPath.indexOf(a) - criticalPath.indexOf(b)
			}

			return 0
		})

		return prioritized.slice(0, availableWorkers)
	}
}

/**
 * Orchestration Scheduler
 *
 * Main scheduler that:
 * - Analyzes task dependencies using TaskGraph
 * - Selects appropriate scheduling strategy
 * - Coordinates task execution via ParallelInstanceManager
 * - Communicates via IPCChannel
 * - Handles task completion and re-scheduling
 */
export class OrchestrationScheduler extends EventEmitter {
	private graph: TaskGraph
	private strategy: SchedulingStrategy
	private instanceManager: ParallelInstanceManager
	private ipcChannel: IPCChannel
	private executionState: Map<string, "pending" | "running" | "completed" | "failed"> = new Map()
	private workerMapping: Map<string, string> = new Map() // taskId -> workerId
	private currentRPM: number = 0
	private options: SchedulerOptions

	constructor(tasks: TaskWithDependencies[], options: SchedulerOptions) {
		super()

		// Build task graph
		this.graph = new TaskGraph(tasks)

		// Initialize execution state
		for (const task of tasks) {
			this.executionState.set(task.id, "pending")
		}

		// Store options
		this.options = options
		this.instanceManager = options.instanceManager
		this.ipcChannel = options.ipc

		// Select strategy
		this.strategy = this.selectStrategy(options)

		// Set up IPC handlers
		this.setupIPCHandlers()
	}

	/**
	 * Select scheduling strategy based on options
	 */
	private selectStrategy(options: SchedulerOptions): SchedulingStrategy {
		switch (options.strategy) {
			case "max-parallel":
				return new MaxParallelStrategy()

			case "rate-aware":
				return new RateAwareStrategy(options.maxRPM ?? 3800, options.estimatedRPMPerTask ?? 15)

			case "critical-path":
				return new CriticalPathStrategy()

			default:
				throw new Error(`Unknown strategy: ${options.strategy}`)
		}
	}

	/**
	 * Set up IPC message handlers
	 */
	private setupIPCHandlers(): void {
		// Handle task completion
		this.ipcChannel.onMessageType("task-completed", (msg) => {
			this.handleTaskCompleted(msg)
		})

		// Handle task failure
		this.ipcChannel.onMessageType("task-failed", (msg) => {
			this.handleTaskFailed(msg)
		})
	}

	/**
	 * Start scheduler execution loop
	 */
	async start(): Promise<void> {
		this.emit("started")

		try {
			while (!this.graph.allTasksComplete()) {
				// Get available tasks
				const availableTasks = this.graph
					.getIndependentTasks()
					.filter((taskId) => this.executionState.get(taskId) === "pending")

				if (availableTasks.length === 0) {
					// No tasks ready, wait for completion
					await this.waitForTaskCompletion()
					continue
				}

				// Calculate available workers
				const availableWorkers = this.getAvailableWorkerCount()

				if (availableWorkers === 0) {
					// No workers available, wait for completion
					await this.waitForTaskCompletion()
					continue
				}

				// Select tasks to spawn using strategy
				const tasksToSpawn = this.strategy.selectTasks(
					availableTasks,
					availableWorkers,
					this.currentRPM,
					this.graph,
				)

				// Spawn selected tasks
				for (const taskId of tasksToSpawn) {
					await this.assignTask(taskId)
				}

				// Wait for at least one task to complete before next iteration
				if (tasksToSpawn.length === 0) {
					await this.waitForTaskCompletion()
				}
			}

			this.emit("completed")
		} catch (error) {
			this.emit("error", error)
			throw error
		}
	}

	/**
	 * Assign task to a worker
	 */
	private async assignTask(taskId: string): Promise<void> {
		const taskDetails = this.graph.getTaskDetails(taskId)
		if (!taskDetails) {
			throw new Error(`Task ${taskId} not found in graph`)
		}

		try {
			// Spawn worker
			const worker = await this.instanceManager.spawnWorker({
				taskId,
				workingDir: taskDetails.workspacePath,
				systemPrompt: taskDetails.instructions,
			})

			// Track worker mapping
			this.workerMapping.set(taskId, worker.id)

			// Update execution state
			this.executionState.set(taskId, "running")

			// Send task assignment via IPC
			await this.ipcChannel.send({
				type: "task-assignment",
				from: "orchestrator",
				to: worker.id,
				payload: {
					taskId,
					instructions: taskDetails.instructions,
					workspacePath: taskDetails.workspacePath,
					workerType: taskDetails.workerType,
				},
			})

			// Update RPM estimate
			if (taskDetails.estimatedRPM) {
				this.currentRPM += taskDetails.estimatedRPM
			} else {
				this.currentRPM += this.options.estimatedRPMPerTask ?? 15
			}

			this.emit("task-assigned", taskId, worker.id)
		} catch (error) {
			this.executionState.set(taskId, "failed")
			this.emit("task-assign-failed", taskId, error)
			throw error
		}
	}

	/**
	 * Handle task completion message
	 */
	private handleTaskCompleted(msg: IPCMessage): void {
		const { taskId } = msg.payload

		// Update graph
		this.graph.markCompleted(taskId)

		// Update execution state
		this.executionState.set(taskId, "completed")

		// Update RPM estimate
		const taskDetails = this.graph.getTaskDetails(taskId)
		if (taskDetails?.estimatedRPM) {
			this.currentRPM = Math.max(0, this.currentRPM - taskDetails.estimatedRPM)
		} else {
			this.currentRPM = Math.max(0, this.currentRPM - (this.options.estimatedRPMPerTask ?? 15))
		}

		this.emit("task-completed", taskId)
	}

	/**
	 * Handle task failure message
	 */
	private handleTaskFailed(msg: IPCMessage): void {
		const { taskId, error } = msg.payload

		// Update execution state
		this.executionState.set(taskId, "failed")

		// Update RPM estimate
		const taskDetails = this.graph.getTaskDetails(taskId)
		if (taskDetails?.estimatedRPM) {
			this.currentRPM = Math.max(0, this.currentRPM - taskDetails.estimatedRPM)
		} else {
			this.currentRPM = Math.max(0, this.currentRPM - (this.options.estimatedRPMPerTask ?? 15))
		}

		this.emit("task-failed", taskId, error)
	}

	/**
	 * Wait for at least one task completion
	 */
	private async waitForTaskCompletion(): Promise<void> {
		return new Promise((resolve) => {
			const handler = () => {
				this.removeListener("task-completed", handler)
				this.removeListener("task-failed", handler)
				resolve()
			}

			this.once("task-completed", handler)
			this.once("task-failed", handler)
		})
	}

	/**
	 * Get number of available worker slots
	 */
	private getAvailableWorkerCount(): number {
		const runningCount = Array.from(this.executionState.values()).filter((state) => state === "running").length

		// Assuming max workers is accessible via instance manager
		// For now, return a conservative estimate
		return Math.max(0, 10 - runningCount)
	}

	/**
	 * Get current execution progress
	 */
	getProgress(): {
		total: number
		pending: number
		running: number
		completed: number
		failed: number
	} {
		const states = Array.from(this.executionState.values())

		return {
			total: this.graph.getTaskCount(),
			pending: states.filter((s) => s === "pending").length,
			running: states.filter((s) => s === "running").length,
			completed: states.filter((s) => s === "completed").length,
			failed: states.filter((s) => s === "failed").length,
		}
	}

	/**
	 * Get current RPM estimate
	 */
	getCurrentRPM(): number {
		return this.currentRPM
	}

	/**
	 * Get task execution state
	 */
	getTaskState(taskId: string): "pending" | "running" | "completed" | "failed" | undefined {
		return this.executionState.get(taskId)
	}
}
