import { EventEmitter } from "events"
import { IPCChannel, IPCMessage } from "./IPCChannel"
import { ParallelInstanceManager } from "./ParallelInstanceManager"
import { v4 as uuidv4 } from "uuid"

export interface ReviewRequest {
	taskId: string
	workerId: string
	filesChanged: string[]
	description: string
	specialization?: "security" | "performance" | "style"
}

export interface ReviewResponse {
	reviewId: string
	reviewerId: string
	status: "pending" | "approved" | "rejected"
}

export interface ReviewResult {
	approved: boolean
	reviewerId: string
	feedback: string
	issues?: ReviewIssue[]
	suggestions?: string[]
}

export interface ReviewIssue {
	severity: "critical" | "major" | "minor"
	file: string
	line?: number
	description: string
	suggestion: string
}

interface PendingReview {
	reviewId: string
	taskId: string
	workerId: string
	reviewerId: string
	resolve: (result: ReviewResult) => void
	reject: (error: Error) => void
	timeout: NodeJS.Timeout
}

/**
 * ReviewCoordinator manages the async code review lifecycle between Workers and Reviewers.
 *
 * Responsibilities:
 * - Route review requests to appropriate reviewer specialization
 * - Support worker blocking via waitForReviewApproval()
 * - Handle review approval/rejection flows
 * - Track pending reviews and timeouts
 * - Spawn reviewers on-demand as needed
 *
 * Example usage:
 * ```typescript
 * const coordinator = new ReviewCoordinator(ipcChannel, instanceManager);
 *
 * // Worker requests review
 * const response = await coordinator.requestReview({
 *   taskId: 'auth-impl',
 *   workerId: 'worker-1',
 *   filesChanged: ['src/auth/login.ts'],
 *   description: 'Implemented JWT authentication'
 * });
 *
 * // Worker blocks until review complete
 * const result = await coordinator.waitForReviewApproval('auth-impl');
 *
 * if (result.approved) {
 *   console.log('Review approved!', result.feedback);
 * } else {
 *   console.log('Review rejected:', result.issues);
 * }
 * ```
 */
export class ReviewCoordinator extends EventEmitter {
	private pendingReviews: Map<string, PendingReview> = new Map()
	private activeReviewers: Map<string, string> = new Map() // specialization -> reviewerId

	constructor(
		private ipcChannel: IPCChannel,
		private instanceManager: ParallelInstanceManager,
	) {
		super()
		this.setupMessageHandlers()
	}

	/**
	 * Request code review for worker output
	 *
	 * @param request - Review request details
	 * @returns Review response with reviewId and status
	 */
	async requestReview(request: ReviewRequest): Promise<ReviewResponse> {
		const reviewId = uuidv4()
		const specialization = request.specialization || this.selectSpecialization(request.taskId)

		// Ensure reviewer is available (spawn if needed)
		const reviewerId = await this.ensureReviewerAvailable(specialization)

		// Send review request via IPC
		await this.ipcChannel.send({
			type: "review-request",
			from: request.workerId,
			to: reviewerId,
			payload: {
				reviewId,
				taskId: request.taskId,
				filesChanged: request.filesChanged,
				description: request.description,
			},
		})

		return {
			reviewId,
			reviewerId,
			status: "pending",
		}
	}

	/**
	 * Worker blocks until review is approved or rejected
	 *
	 * @param taskId - Task ID to wait for review
	 * @param timeout - Timeout in ms (default: 5 minutes)
	 * @returns Review result with approval status, feedback, and issues/suggestions
	 * @throws Error if review times out
	 */
	async waitForReviewApproval(taskId: string, timeout: number = 300000): Promise<ReviewResult> {
		return new Promise<ReviewResult>((resolve, reject) => {
			// Set timeout
			const timeoutHandle = setTimeout(() => {
				this.pendingReviews.delete(taskId)
				reject(new Error(`Review timeout after ${timeout}ms for task ${taskId}`))
			}, timeout)

			// Store pending review
			this.pendingReviews.set(taskId, {
				reviewId: taskId, // Simplified: use taskId as reviewId
				taskId,
				workerId: "", // Will be populated from message
				reviewerId: "", // Will be populated from message
				resolve,
				reject,
				timeout: timeoutHandle,
			})
		})
	}

	/**
	 * Select reviewer specialization based on task type
	 *
	 * Patterns:
	 * - Security: auth, login, password, token, encrypt
	 * - Performance: optimize, performance, cache, query, index, batch
	 * - Style: default for all other tasks
	 *
	 * @param taskId - Task ID to analyze
	 * @returns Appropriate reviewer specialization
	 */
	private selectSpecialization(taskId: string): "security" | "performance" | "style" {
		const lower = taskId.toLowerCase()

		// Security-sensitive patterns
		if (
			lower.includes("auth") ||
			lower.includes("security") ||
			lower.includes("login") ||
			lower.includes("password") ||
			lower.includes("token") ||
			lower.includes("encrypt")
		) {
			return "security"
		}

		// Performance-critical patterns
		if (
			lower.includes("optimize") ||
			lower.includes("performance") ||
			lower.includes("cache") ||
			lower.includes("query") ||
			lower.includes("index") ||
			lower.includes("batch")
		) {
			return "performance"
		}

		// Default to style review
		return "style"
	}

	/**
	 * Ensure a reviewer of the given specialization is available
	 * Spawns one if needed, reuses existing if available
	 *
	 * @param specialization - Reviewer specialization needed
	 * @returns Reviewer ID
	 */
	private async ensureReviewerAvailable(specialization: string): Promise<string> {
		// Check if reviewer already active
		const existingReviewer = this.activeReviewers.get(specialization)
		if (existingReviewer) {
			return existingReviewer
		}

		// Spawn new reviewer
		const reviewerId = `reviewer-${specialization}-${uuidv4().substring(0, 8)}`

		const worker = await this.instanceManager.spawnWorker({
			taskId: reviewerId,
			workingDir: "./", // Reviewers don't need isolated workspace
			systemPrompt: `You are a ${specialization} code reviewer. Review code changes for quality and provide feedback.`,
			mcpServers: [], // Reviewers typically don't need MCP servers
		})

		this.activeReviewers.set(specialization, worker.id)
		return worker.id
	}

	/**
	 * Set up IPC message handlers for review responses
	 */
	private setupMessageHandlers(): void {
		this.ipcChannel.on("message", (message: IPCMessage) => {
			if (message.type === "review-approved") {
				this.handleReviewApproved(message)
			} else if (message.type === "review-rejected") {
				this.handleReviewRejected(message)
			}
		})
	}

	/**
	 * Handle review approval from reviewer
	 *
	 * @param message - IPC message with approval details
	 */
	private handleReviewApproved(message: IPCMessage): void {
		const { taskId, approved, feedback, suggestions } = message.payload
		const pending = this.pendingReviews.get(taskId)

		if (!pending) {
			console.warn(`Received review-approved for unknown task: ${taskId}`)
			return
		}

		clearTimeout(pending.timeout)
		this.pendingReviews.delete(taskId)

		pending.resolve({
			approved: true,
			reviewerId: message.from,
			feedback: feedback || "Review approved",
			suggestions: suggestions || [],
		})
	}

	/**
	 * Handle review rejection from reviewer
	 *
	 * @param message - IPC message with rejection details and issues
	 */
	private handleReviewRejected(message: IPCMessage): void {
		const { taskId, approved, feedback, issues } = message.payload
		const pending = this.pendingReviews.get(taskId)

		if (!pending) {
			console.warn(`Received review-rejected for unknown task: ${taskId}`)
			return
		}

		clearTimeout(pending.timeout)
		this.pendingReviews.delete(taskId)

		pending.resolve({
			approved: false,
			reviewerId: message.from,
			feedback: feedback || "Review rejected - see issues",
			issues: issues || [],
		})
	}

	/**
	 * Clean up resources
	 * Clears all pending reviews and rejects their promises
	 */
	dispose(): void {
		// Clear all pending reviews
		for (const [taskId, pending] of this.pendingReviews.entries()) {
			clearTimeout(pending.timeout)
			pending.reject(new Error("ReviewCoordinator disposed"))
		}
		this.pendingReviews.clear()
		this.activeReviewers.clear()
	}
}
