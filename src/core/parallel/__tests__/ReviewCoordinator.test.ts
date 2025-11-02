import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ReviewCoordinator, ReviewRequest } from "../ReviewCoordinator"
import { IPCChannel, IPCMessage } from "../IPCChannel"
import { ParallelInstanceManager } from "../ParallelInstanceManager"

// Mock dependencies
vi.mock("../IPCChannel")
vi.mock("../ParallelInstanceManager")

describe("ReviewCoordinator", () => {
	let coordinator: ReviewCoordinator
	let mockIpcChannel: any
	let mockInstanceManager: any
	let messageHandler: (message: IPCMessage) => void

	beforeEach(() => {
		// Create mock IPC channel with event listener capture
		mockIpcChannel = {
			send: vi.fn().mockResolvedValue(undefined),
			on: vi.fn((event: string, handler: any) => {
				if (event === "message") {
					messageHandler = handler
				}
			}),
		}

		// Create mock instance manager
		mockInstanceManager = {
			spawnWorker: vi.fn().mockResolvedValue({
				id: "reviewer-test-123",
				task: {},
				workingDir: "./",
				createdAt: new Date(),
				status: "idle",
			}),
		}

		coordinator = new ReviewCoordinator(mockIpcChannel, mockInstanceManager)
	})

	afterEach(() => {
		coordinator.dispose()
		vi.clearAllMocks()
	})

	describe("requestReview", () => {
		it("should request review and return pending status", async () => {
			const request: ReviewRequest = {
				taskId: "auth-impl",
				workerId: "worker-1",
				filesChanged: ["src/auth/login.ts"],
				description: "Implemented JWT authentication",
			}

			const response = await coordinator.requestReview(request)

			expect(response.status).toBe("pending")
			expect(response.reviewerId).toBe("reviewer-test-123")
			expect(response.reviewId).toBeDefined()
			expect(mockIpcChannel.send).toHaveBeenCalledWith({
				type: "review-request",
				from: "worker-1",
				to: "reviewer-test-123",
				payload: expect.objectContaining({
					taskId: "auth-impl",
					filesChanged: ["src/auth/login.ts"],
					description: "Implemented JWT authentication",
				}),
			})
		})

		it("should use explicit specialization if provided", async () => {
			const request: ReviewRequest = {
				taskId: "generic-task",
				workerId: "worker-1",
				filesChanged: ["src/utils.ts"],
				description: "Utility functions",
				specialization: "performance",
			}

			await coordinator.requestReview(request)

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining("performance"),
				}),
			)
		})

		it("should send review request with correct IPC message format", async () => {
			const request: ReviewRequest = {
				taskId: "test-task",
				workerId: "worker-2",
				filesChanged: ["file1.ts", "file2.ts"],
				description: "Test implementation",
			}

			await coordinator.requestReview(request)

			const sendCall = mockIpcChannel.send.mock.calls[0][0]
			expect(sendCall.type).toBe("review-request")
			expect(sendCall.from).toBe("worker-2")
			expect(sendCall.to).toBe("reviewer-test-123")
			expect(sendCall.payload).toMatchObject({
				taskId: "test-task",
				filesChanged: ["file1.ts", "file2.ts"],
				description: "Test implementation",
			})
		})
	})

	describe("selectSpecialization", () => {
		it("should select security for auth-related tasks", async () => {
			await coordinator.requestReview({
				taskId: "auth-login-implementation",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test",
			})

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining("security"),
				}),
			)
		})

		it("should select performance for optimization tasks", async () => {
			await coordinator.requestReview({
				taskId: "optimize-database-queries",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test",
			})

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining("performance"),
				}),
			)
		})

		it("should default to style for general tasks", async () => {
			await coordinator.requestReview({
				taskId: "refactor-utils",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test",
			})

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining("style"),
				}),
			)
		})

		it("should be case-insensitive", async () => {
			await coordinator.requestReview({
				taskId: "AUTH-LOGIN",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test",
			})

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining("security"),
				}),
			)
		})
	})

	describe("waitForReviewApproval", () => {
		it("should resolve with approval result when review approved", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-1")

			// Simulate review approval message
			messageHandler({
				id: "msg-1",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-security-123",
				to: "worker-1",
				payload: {
					taskId: "task-1",
					approved: true,
					feedback: "Security review passed",
					suggestions: ["Consider adding rate limiting", "Add input validation"],
				},
			})

			const result = await approvalPromise

			expect(result.approved).toBe(true)
			expect(result.reviewerId).toBe("reviewer-security-123")
			expect(result.feedback).toBe("Security review passed")
			expect(result.suggestions).toEqual(["Consider adding rate limiting", "Add input validation"])
		})

		it("should resolve with rejection result when review rejected", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-2")

			// Simulate review rejection message
			messageHandler({
				id: "msg-2",
				timestamp: Date.now(),
				type: "review-rejected",
				from: "reviewer-security-456",
				to: "worker-2",
				payload: {
					taskId: "task-2",
					approved: false,
					feedback: "Critical security issues found",
					issues: [
						{
							severity: "critical" as const,
							file: "src/auth.ts",
							line: 42,
							description: "SQL injection vulnerability",
							suggestion: "Use parameterized queries",
						},
						{
							severity: "major" as const,
							file: "src/auth.ts",
							line: 58,
							description: "Weak password validation",
							suggestion: "Enforce stronger password policy",
						},
					],
				},
			})

			const result = await approvalPromise

			expect(result.approved).toBe(false)
			expect(result.reviewerId).toBe("reviewer-security-456")
			expect(result.feedback).toBe("Critical security issues found")
			expect(result.issues).toHaveLength(2)
			expect(result.issues![0].severity).toBe("critical")
			expect(result.issues![1].severity).toBe("major")
		})

		it("should timeout if no response received within timeout period", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-timeout", 100)

			await expect(approvalPromise).rejects.toThrow("Review timeout after 100ms for task task-timeout")
		})

		it("should use default 5-minute timeout when not specified", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-default-timeout")

			// Verify timeout is set to 300000ms (5 minutes)
			// We can't easily test the actual timeout value, but we can verify it doesn't timeout quickly
			const timeoutTestPromise = Promise.race([
				approvalPromise,
				new Promise((resolve) => setTimeout(() => resolve("still-pending"), 200)),
			])

			const result = await timeoutTestPromise
			expect(result).toBe("still-pending")

			// Send approval to clean up
			messageHandler({
				id: "msg-cleanup-1",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-1",
				payload: { taskId: "task-default-timeout", approved: true },
			})
		})

		it("should handle approval with minimal payload", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-minimal")

			messageHandler({
				id: "msg-minimal-1",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-1",
				payload: {
					taskId: "task-minimal",
					approved: true,
				},
			})

			const result = await approvalPromise

			expect(result.approved).toBe(true)
			expect(result.feedback).toBe("Review approved") // Default message
			expect(result.suggestions).toEqual([]) // Default empty array
		})

		it("should handle rejection with minimal payload", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-minimal-reject")

			messageHandler({
				id: "msg-minimal-reject-1",
				timestamp: Date.now(),
				type: "review-rejected",
				from: "reviewer-1",
				to: "worker-1",
				payload: {
					taskId: "task-minimal-reject",
					approved: false,
				},
			})

			const result = await approvalPromise

			expect(result.approved).toBe(false)
			expect(result.feedback).toBe("Review rejected - see issues")
			expect(result.issues).toEqual([])
		})
	})

	describe("ensureReviewerAvailable", () => {
		it("should reuse existing reviewer of same specialization", async () => {
			// First request spawns reviewer
			await coordinator.requestReview({
				taskId: "task-1",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test 1",
				specialization: "security",
			})

			// Second request should reuse same reviewer
			await coordinator.requestReview({
				taskId: "task-2",
				workerId: "worker-2",
				filesChanged: [],
				description: "Test 2",
				specialization: "security",
			})

			// spawnWorker should only be called once
			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledTimes(1)
		})

		it("should spawn different reviewers for different specializations", async () => {
			mockInstanceManager.spawnWorker
				.mockResolvedValueOnce({ id: "reviewer-security-1" })
				.mockResolvedValueOnce({ id: "reviewer-performance-1" })
				.mockResolvedValueOnce({ id: "reviewer-style-1" })

			// Request reviews for different specializations
			await coordinator.requestReview({
				taskId: "task-security",
				workerId: "worker-1",
				filesChanged: [],
				description: "Security test",
				specialization: "security",
			})

			await coordinator.requestReview({
				taskId: "task-performance",
				workerId: "worker-2",
				filesChanged: [],
				description: "Performance test",
				specialization: "performance",
			})

			await coordinator.requestReview({
				taskId: "task-style",
				workerId: "worker-3",
				filesChanged: [],
				description: "Style test",
				specialization: "style",
			})

			// Should spawn 3 different reviewers
			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledTimes(3)
		})

		it("should spawn reviewer with correct configuration", async () => {
			await coordinator.requestReview({
				taskId: "auth-task",
				workerId: "worker-1",
				filesChanged: [],
				description: "Auth implementation",
			})

			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledWith({
				taskId: expect.stringContaining("reviewer-security"),
				workingDir: "./",
				systemPrompt: "You are a security code reviewer. Review code changes for quality and provide feedback.",
				mcpServers: [],
			})
		})
	})

	describe("message handling", () => {
		it("should ignore review-approved for unknown task", async () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			messageHandler({
				id: "msg-unknown-1",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-1",
				payload: {
					taskId: "unknown-task",
					approved: true,
				},
			})

			expect(consoleWarnSpy).toHaveBeenCalledWith("Received review-approved for unknown task: unknown-task")

			consoleWarnSpy.mockRestore()
		})

		it("should ignore review-rejected for unknown task", async () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			messageHandler({
				id: "msg-unknown-reject-1",
				timestamp: Date.now(),
				type: "review-rejected",
				from: "reviewer-1",
				to: "worker-1",
				payload: {
					taskId: "unknown-task",
					approved: false,
				},
			})

			expect(consoleWarnSpy).toHaveBeenCalledWith("Received review-rejected for unknown task: unknown-task")

			consoleWarnSpy.mockRestore()
		})

		it("should clear timeout when review completes", async () => {
			const approvalPromise = coordinator.waitForReviewApproval("task-clear-timeout")

			// Simulate review approval
			messageHandler({
				id: "msg-clear-timeout-1",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-1",
				payload: {
					taskId: "task-clear-timeout",
					approved: true,
				},
			})

			await approvalPromise

			// Wait a bit to ensure timeout doesn't fire
			await new Promise((resolve) => setTimeout(resolve, 50))

			// If timeout wasn't cleared, this test would fail due to timeout error
		})
	})

	describe("concurrent reviews", () => {
		it("should handle multiple concurrent reviews", async () => {
			const approval1 = coordinator.waitForReviewApproval("task-1")
			const approval2 = coordinator.waitForReviewApproval("task-2")
			const approval3 = coordinator.waitForReviewApproval("task-3")

			// Approve task-2
			messageHandler({
				id: "msg-8",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-2",
				payload: { taskId: "task-2", approved: true },
			})

			// Reject task-1
			messageHandler({
				id: "msg-9",
				timestamp: Date.now(),
				type: "review-rejected",
				from: "reviewer-2",
				to: "worker-1",
				payload: {
					taskId: "task-1",
					approved: false,
					issues: [{ severity: "major", file: "test.ts", description: "Issue", suggestion: "Fix" }],
				},
			})

			// Approve task-3
			messageHandler({
				id: "msg-10",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-3",
				to: "worker-3",
				payload: { taskId: "task-3", approved: true },
			})

			const [result1, result2, result3] = await Promise.all([approval1, approval2, approval3])

			expect(result1.approved).toBe(false)
			expect(result2.approved).toBe(true)
			expect(result3.approved).toBe(true)
		})

		it("should handle mixed approval and timeout scenarios", async () => {
			const approval1 = coordinator.waitForReviewApproval("task-approved", 5000)
			const approval2 = coordinator.waitForReviewApproval("task-timeout", 100)

			// Approve task-approved
			messageHandler({
				id: "msg-11",
				timestamp: Date.now(),
				type: "review-approved",
				from: "reviewer-1",
				to: "worker-1",
				payload: { taskId: "task-approved", approved: true },
			})

			const result1 = await approval1
			expect(result1.approved).toBe(true)

			await expect(approval2).rejects.toThrow("Review timeout")
		})
	})

	describe("dispose", () => {
		it("should clear all pending reviews on dispose", async () => {
			const approval1 = coordinator.waitForReviewApproval("task-1")
			const approval2 = coordinator.waitForReviewApproval("task-2")

			coordinator.dispose()

			await expect(approval1).rejects.toThrow("ReviewCoordinator disposed")
			await expect(approval2).rejects.toThrow("ReviewCoordinator disposed")
		})

		it("should clear active reviewers on dispose", async () => {
			await coordinator.requestReview({
				taskId: "task-1",
				workerId: "worker-1",
				filesChanged: [],
				description: "Test",
				specialization: "security",
			})

			coordinator.dispose()

			// After dispose, next request should spawn new reviewer
			await coordinator.requestReview({
				taskId: "task-2",
				workerId: "worker-2",
				filesChanged: [],
				description: "Test",
				specialization: "security",
			})

			// spawnWorker should be called twice (once before dispose, once after)
			expect(mockInstanceManager.spawnWorker).toHaveBeenCalledTimes(2)
		})
	})

	describe("error scenarios", () => {
		it("should handle spawnWorker failure gracefully", async () => {
			mockInstanceManager.spawnWorker.mockRejectedValueOnce(new Error("Failed to spawn reviewer"))

			await expect(
				coordinator.requestReview({
					taskId: "task-fail",
					workerId: "worker-1",
					filesChanged: [],
					description: "Test",
				}),
			).rejects.toThrow("Failed to spawn reviewer")
		})

		it("should handle IPC send failure gracefully", async () => {
			mockIpcChannel.send.mockRejectedValueOnce(new Error("IPC communication error"))

			await expect(
				coordinator.requestReview({
					taskId: "task-ipc-fail",
					workerId: "worker-1",
					filesChanged: [],
					description: "Test",
				}),
			).rejects.toThrow("IPC communication error")
		})
	})
})
