/**
 * Unit tests for IPCChannel
 *
 * Tests TCP socket communication, message routing, and BridgeOrchestrator fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { IPCChannel, type IPCMessage } from "../IPCChannel"

describe("IPCChannel", () => {
	let serverChannel: IPCChannel
	let clientChannel: IPCChannel
	let serverPort: number

	beforeEach(async () => {
		// Create server channel
		serverChannel = new IPCChannel({
			port: 0, // Dynamic port
			maxQueueSize: 100,
			messageTimeout: 5000,
			enableRemoteFallback: false, // Disable for local tests
			maxReconnectAttempts: 3,
			reconnectDelay: 100,
		})

		// Start server and get port
		serverPort = await serverChannel.startServer()

		// Create client
		clientChannel = new IPCChannel({
			maxQueueSize: 100,
			messageTimeout: 5000,
			enableRemoteFallback: false,
		})
	})

	afterEach(async () => {
		// Clean up
		try {
			await clientChannel.stop()
		} catch (e) {
			// Ignore cleanup errors
		}
		try {
			await serverChannel.stop()
		} catch (e) {
			// Ignore cleanup errors
		}
	})

	describe("Connection Management", () => {
		it("should start server on dynamic port", () => {
			expect(serverPort).toBeGreaterThan(0)
			expect(serverChannel.isConnected()).toBe(true)
		})

		it("should connect client to server", async () => {
			await clientChannel.connect(serverPort)

			// Wait a bit for connection
			await new Promise((resolve) => setTimeout(resolve, 50))

			expect(clientChannel.isConnected()).toBe(true)
		})
	})

	describe("Message Routing", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should route task-completed message from client to server", async () => {
			const messageReceived = new Promise<IPCMessage>((resolve) => {
				serverChannel.on("message", (msg) => {
					if (msg.type === "task-completed") {
						resolve(msg)
					}
				})
			})

			await clientChannel.send({
				type: "task-completed",
				from: "worker-1",
				to: "orchestrator",
				payload: { taskId: "task-1", result: "success" },
			})

			const received = await messageReceived
			expect(received.type).toBe("task-completed")
			expect(received.from).toBe("worker-1")
			expect((received.payload as any).result).toBe("success")
		})

		it("should route review-request message", async () => {
			const messageReceived = new Promise<IPCMessage>((resolve) => {
				serverChannel.on("message", (msg) => {
					if (msg.type === "review-request") {
						resolve(msg)
					}
				})
			})

			await clientChannel.send({
				type: "review-request",
				from: "worker-1",
				to: "reviewer",
				payload: { changes: ["file1.ts", "file2.ts"] },
			})

			const received = await messageReceived
			expect(received.type).toBe("review-request")
		})

		it("should route escalation message", async () => {
			const messageReceived = new Promise<IPCMessage>((resolve) => {
				serverChannel.on("message", (msg) => {
					if (msg.type === "escalation") {
						resolve(msg)
					}
				})
			})

			await clientChannel.send({
				type: "escalation",
				from: "worker-1",
				to: "orchestrator",
				payload: { reason: "blocked", details: "Cannot proceed" },
			})

			const received = await messageReceived
			expect(received.type).toBe("escalation")
			expect((received.payload as any).reason).toBe("blocked")
		})
	})

	describe("Message Serialization", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should serialize and deserialize JSON messages", async () => {
			const complexPayload = {
				nested: {
					data: ["item1", "item2"],
					number: 42,
					boolean: true,
				},
			}

			const messageReceived = new Promise<IPCMessage>((resolve) => {
				serverChannel.on("message", (msg) => {
					if (msg.type === "task-completed") {
						resolve(msg)
					}
				})
			})

			await clientChannel.send({
				type: "task-completed",
				from: "worker-1",
				to: "orchestrator",
				payload: complexPayload,
			})

			const received = await messageReceived
			expect(received.payload).toEqual(complexPayload)
		})

		it("should handle multiple messages rapidly", async () => {
			const messages: IPCMessage[] = []
			const messageCount = 10

			serverChannel.on("message", (msg) => {
				if (msg.type === "heartbeat") {
					messages.push(msg)
				}
			})

			// Send multiple messages rapidly
			for (let i = 0; i < messageCount; i++) {
				await clientChannel.send({
					type: "heartbeat",
					from: "worker-1",
					to: "orchestrator",
					payload: { seq: i },
				})
			}

			// Wait for all messages
			await new Promise((resolve) => setTimeout(resolve, 500))

			expect(messages.length).toBe(messageCount)
		})
	})

	describe("Message Queue and Timeout", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should timeout waiting for non-existent message", async () => {
			await expect(
				clientChannel.waitForMessage<any>((msg) => (msg.payload as any)?.nonExistent === true, 500),
			).rejects.toThrow("Message wait timeout")
		})
	})

	describe("Message Type Handlers", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should register and call message type handlers", async () => {
			const handlerSpy = vi.fn()
			serverChannel.onMessageType("task-completed", handlerSpy)

			await clientChannel.send({
				type: "task-completed",
				from: "worker-1",
				to: "orchestrator",
				payload: { result: "done" },
			})

			await new Promise((resolve) => setTimeout(resolve, 200))

			expect(handlerSpy).toHaveBeenCalled()
			expect(handlerSpy.mock.calls[0][0].type).toBe("task-completed")
		})
	})

	describe("Remote Fallback", () => {
		it("should mark workers as remote", () => {
			const fallbackChannel = new IPCChannel({
				enableRemoteFallback: true,
			})

			fallbackChannel.markWorkerRemote("remote-worker-1")

			// Clean up
			fallbackChannel.dispose()
		})
	})

	describe("Performance Benchmarks", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should achieve <200ms p95 latency for message routing", async () => {
			const latencies: number[] = []
			const messageCount = 50 // Reduced for faster test

			for (let i = 0; i < messageCount; i++) {
				const startTime = Date.now()

				const messageReceived = new Promise<void>((resolve) => {
					const handler = (msg: IPCMessage) => {
						if (msg.type === "heartbeat" && (msg.payload as any).seq === i) {
							const endTime = Date.now()
							latencies.push(endTime - startTime)
							serverChannel.off("message", handler)
							resolve()
						}
					}
					serverChannel.on("message", handler)
				})

				await clientChannel.send({
					type: "heartbeat",
					from: "worker-1",
					to: "orchestrator",
					payload: { seq: i },
				})

				await messageReceived
			}

			// Calculate percentiles
			latencies.sort((a, b) => a - b)
			const p50 = latencies[Math.floor(latencies.length * 0.5)]
			const p95 = latencies[Math.floor(latencies.length * 0.95)]
			const p99 = latencies[Math.floor(latencies.length * 0.99)]
			const avg = latencies.reduce((sum, l) => sum + l, 0) / latencies.length

			console.log(`\nLatency Benchmarks (${messageCount} messages):`)
			console.log(`  Average: ${avg.toFixed(2)}ms`)
			console.log(`  p50: ${p50}ms`)
			console.log(`  p95: ${p95}ms`)
			console.log(`  p99: ${p99}ms`)

			// Verify p95 latency target
			expect(p95).toBeLessThan(200)
		}, 30000) // Extended timeout for benchmark

		it("should handle high message throughput", async () => {
			const messageCount = 100

			let receivedCount = 0
			serverChannel.on("message", (msg) => {
				if (msg.type === "heartbeat") {
					receivedCount++
				}
			})

			const startTime = Date.now()

			// Send messages as fast as possible
			const sendPromises = []
			for (let i = 0; i < messageCount; i++) {
				sendPromises.push(
					clientChannel.send({
						type: "heartbeat",
						from: "worker-1",
						to: "orchestrator",
						payload: { seq: i },
					}),
				)
			}

			await Promise.all(sendPromises)

			// Wait for all messages to be received
			await new Promise((resolve) => setTimeout(resolve, 1000))

			const endTime = Date.now()
			const duration = (endTime - startTime) / 1000 // seconds
			const throughput = receivedCount / duration

			console.log(
				`\nThroughput: ${throughput.toFixed(0)} messages/sec (${receivedCount}/${messageCount} received)`,
			)

			// Should get most messages
			expect(receivedCount).toBeGreaterThan(messageCount * 0.9)
		}, 15000)
	})

	describe("Correlation IDs", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		it("should support request/response correlation", async () => {
			const correlationId = "test-correlation-123"

			// Send request with correlation ID from client
			await clientChannel.send({
				type: "review-request",
				from: "worker-1",
				to: "reviewer",
				payload: { changes: ["file.ts"] },
				correlationId,
			})

			// Wait for server to receive it
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Set up client to wait for response
			const responsePromise = clientChannel.waitForMessage<any>(
				(msg) => msg.correlationId === correlationId && msg.type === "review-approved",
				2000,
			)

			// Simulate server sending response (broadcast since worker ID mapping)
			const responseMsg: IPCMessage = {
				id: "response-1",
				type: "review-approved",
				from: "reviewer",
				to: "worker-1",
				payload: { approved: true },
				correlationId,
				timestamp: Date.now(),
			}

			// Use broadcast since we don't have worker ID mapping yet
			if (serverChannel["server"]) {
				serverChannel["server"].broadcast(responseMsg)
			}

			const response = await responsePromise
			expect(response.correlationId).toBe(correlationId)
			expect(response.type).toBe("review-approved")
		})
	})

	describe("Cleanup and Disposal", () => {
		it("should clean up resources on stop", async () => {
			const channel = new IPCChannel({ enableRemoteFallback: false })
			const port = await channel.startServer()

			expect(channel.isConnected()).toBe(true)

			await channel.stop()

			expect(channel.isConnected()).toBe(false)
		})

		it("should dispose of internal state", () => {
			const channel = new IPCChannel()

			channel.dispose()

			// Should not throw
			expect(channel.getPort()).toBeGreaterThanOrEqual(0)
		})
	})

	describe("All Message Types", () => {
		beforeEach(async () => {
			await clientChannel.connect(serverPort)
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		const messageTypes: Array<{ type: IPCMessage["type"]; from: string; to: string }> = [
			{ type: "task-assignment", from: "orchestrator", to: "worker-1" },
			{ type: "task-completed", from: "worker-1", to: "orchestrator" },
			{ type: "task-failed", from: "worker-1", to: "orchestrator" },
			{ type: "review-request", from: "worker-1", to: "reviewer" },
			{ type: "review-approved", from: "reviewer", to: "worker-1" },
			{ type: "review-rejected", from: "reviewer", to: "worker-1" },
			{ type: "escalation", from: "worker-1", to: "orchestrator" },
			{ type: "heartbeat", from: "worker-1", to: "orchestrator" },
		]

		for (const msgType of messageTypes) {
			it(`should route ${msgType.type} message`, async () => {
				const messageReceived = new Promise<IPCMessage>((resolve) => {
					serverChannel.on("message", (msg) => {
						if (msg.type === msgType.type) {
							resolve(msg)
						}
					})
				})

				await clientChannel.send({
					type: msgType.type,
					from: msgType.from,
					to: msgType.to,
					payload: { test: true },
				})

				const received = await messageReceived
				expect(received.type).toBe(msgType.type)
				expect(received.from).toBe(msgType.from)
				expect(received.to).toBe(msgType.to)
			})
		}
	})
})
