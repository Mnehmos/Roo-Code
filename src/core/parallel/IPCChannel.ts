/**
 * IPCChannel
 *
 * Provides TCP socket-based IPC for local coordination between parallel workers.
 * Implements automatic fallback to BridgeOrchestrator for remote communication.
 *
 * @module core/parallel
 */

import * as net from "net"
import { EventEmitter } from "events"
import { BridgeOrchestrator } from "../../../packages/cloud/src/bridge/BridgeOrchestrator"

/**
 * IPC message types for coordination
 */
export type IPCMessageType =
	| "task-assignment" // Orchestrator → Worker
	| "task-completed" // Worker → Orchestrator
	| "task-failed" // Worker → Orchestrator
	| "review-request" // Worker → Reviewer
	| "review-approved" // Reviewer → Worker
	| "review-rejected" // Reviewer → Worker
	| "escalation" // Worker → Orchestrator
	| "heartbeat" // Bidirectional health check

/**
 * Generic IPC message structure
 */
export interface IPCMessage<T = any> {
	/** Unique message ID */
	id: string

	/** Message type */
	type: IPCMessageType

	/** Source task/worker ID */
	from: string

	/** Destination task/worker ID */
	to: string

	/** Message payload */
	payload: T

	/** Message timestamp */
	timestamp: number

	/** Optional correlation ID for request/response */
	correlationId?: string
}

/**
 * IPC channel configuration
 */
export interface IPCChannelConfig {
	/** Local TCP port for IPC server (0 = dynamic) */
	port: number

	/** Message queue size limit */
	maxQueueSize: number

	/** Message timeout in milliseconds */
	messageTimeout: number

	/** Enable automatic BridgeOrchestrator fallback */
	enableRemoteFallback: boolean

	/** Reconnection attempts */
	maxReconnectAttempts: number

	/** Reconnection delay in milliseconds */
	reconnectDelay: number
}

/**
 * TCP-based IPC server for local coordination
 */
class IPCServer extends EventEmitter {
	private server: net.Server | null = null
	private clients: Map<string, net.Socket> = new Map()
	private workerSockets: Map<string, net.Socket> = new Map()
	private port: number = 0
	private messageBuffer: Map<net.Socket, string> = new Map()

	constructor() {
		super()
	}

	/**
	 * Start TCP server on specified port (0 = dynamic)
	 */
	async start(port: number = 0): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.handleConnection(socket)
			})

			this.server.on("error", (error) => {
				reject(error)
			})

			this.server.listen(port, "127.0.0.1", () => {
				const address = this.server!.address() as net.AddressInfo
				this.port = address.port
				resolve(this.port)
			})
		})
	}

	/**
	 * Handle new client connection
	 */
	private handleConnection(socket: net.Socket): void {
		const clientId = `${socket.remoteAddress}:${socket.remotePort}`
		this.clients.set(clientId, socket)
		this.messageBuffer.set(socket, "")

		this.emit("client-connected", clientId)

		socket.on("data", (data) => {
			this.handleData(socket, clientId, data)
		})

		socket.on("error", (error) => {
			this.emit("error", { clientId, error })
		})

		socket.on("close", () => {
			this.clients.delete(clientId)
			this.messageBuffer.delete(socket)
			// Remove from worker mapping
			for (const [workerId, sock] of this.workerSockets.entries()) {
				if (sock === socket) {
					this.workerSockets.delete(workerId)
					break
				}
			}
			this.emit("client-disconnected", clientId)
		})
	}

	/**
	 * Handle incoming data with newline-delimited JSON parsing
	 */
	private handleData(socket: net.Socket, clientId: string, data: Buffer): void {
		const buffer = this.messageBuffer.get(socket) || ""
		const newData = buffer + data.toString()
		const lines = newData.split("\n")

		// Keep incomplete line in buffer
		this.messageBuffer.set(socket, lines.pop() || "")

		// Process complete lines
		for (const line of lines) {
			if (line.trim()) {
				try {
					const message = JSON.parse(line) as IPCMessage

					// Register worker ID on first message
					if (!this.workerSockets.has(message.from)) {
						this.workerSockets.set(message.from, socket)
					}

					this.emit("message", message)
				} catch (error) {
					this.emit("error", { error, line })
				}
			}
		}
	}

	/**
	 * Send message to specific client by worker ID
	 */
	send(workerId: string, message: IPCMessage): boolean {
		const socket = this.workerSockets.get(workerId)

		if (!socket) {
			return false
		}

		const json = JSON.stringify(message) + "\n"
		socket.write(json)
		return true
	}

	/**
	 * Broadcast message to all clients
	 */
	broadcast(message: IPCMessage): void {
		const json = JSON.stringify(message) + "\n"
		for (const socket of this.clients.values()) {
			socket.write(json)
		}
	}

	/**
	 * Stop server and close all connections
	 */
	async stop(): Promise<void> {
		return new Promise((resolve) => {
			// Close all client connections
			for (const socket of this.clients.values()) {
				socket.destroy()
			}
			this.clients.clear()
			this.workerSockets.clear()
			this.messageBuffer.clear()

			// Close server
			if (this.server) {
				this.server.close(() => {
					this.server = null
					resolve()
				})
			} else {
				resolve()
			}
		})
	}

	getPort(): number {
		return this.port
	}

	isListening(): boolean {
		return this.server !== null && this.server.listening
	}
}

class IPCClient extends EventEmitter {
	private socket: net.Socket | null = null
	private messageBuffer: string = ""
	private reconnectAttempts: number = 0
	private reconnectTimer: NodeJS.Timeout | null = null
	private isConnected: boolean = false

	constructor(
		private port: number,
		private maxReconnectAttempts: number = 5,
		private reconnectDelay: number = 1000,
	) {
		super()
	}

	/**
	 * Connect to IPC server
	 */
	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection({ port: this.port, host: "127.0.0.1" })

			this.socket.on("connect", () => {
				this.isConnected = true
				this.reconnectAttempts = 0
				this.emit("connected")
				resolve()
			})

			this.socket.on("data", (data) => {
				this.handleData(data)
			})

			this.socket.on("error", (error) => {
				this.emit("error", error)
				if (!this.isConnected) {
					reject(error)
				}
			})

			this.socket.on("close", () => {
				this.isConnected = false
				this.emit("disconnected")
				this.attemptReconnect()
			})
		})
	}

	/**
	 * Handle incoming data with newline-delimited JSON parsing
	 */
	private handleData(data: Buffer): void {
		this.messageBuffer += data.toString()
		const lines = this.messageBuffer.split("\n")

		// Keep incomplete line in buffer
		this.messageBuffer = lines.pop() || ""

		// Process complete lines
		for (const line of lines) {
			if (line.trim()) {
				try {
					const message = JSON.parse(line) as IPCMessage
					this.emit("message", message)
				} catch (error) {
					this.emit("error", { error, line })
				}
			}
		}
	}

	/**
	 * Attempt reconnection with exponential backoff
	 */
	private attemptReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.emit("reconnect-failed")
			return
		}

		this.reconnectAttempts++
		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

		this.reconnectTimer = setTimeout(() => {
			this.connect().catch(() => {
				// Reconnection failed, will try again in attemptReconnect
			})
		}, delay)
	}

	/**
	 * Send message to server
	 */
	send(message: IPCMessage): boolean {
		if (!this.socket || !this.isConnected) {
			return false
		}

		const json = JSON.stringify(message) + "\n"
		this.socket.write(json)
		return true
	}

	/**
	 * Disconnect from server
	 */
	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}

		if (this.socket) {
			this.socket.destroy()
			this.socket = null
		}

		this.isConnected = false
		this.messageBuffer = ""
	}

	getConnectionStatus(): boolean {
		return this.isConnected
	}
}

/**
 * Manages local IPC communication between parallel Task instances
 *
 * Key Responsibilities:
 * - Establish TCP socket server for local coordination
 * - Route messages between workers based on task IDs
 * - Implement message queue with timeout handling
 * - Automatic fallback to BridgeOrchestrator for remote workers
 * - Maintain <200ms p95 latency target
 *
 * Design Principles:
 * - Uses newline-delimited JSON over TCP
 * - Leverages existing BridgeOrchestrator for remote fallback
 * - Non-blocking, async message passing
 * - Supports request/response correlation
 */
export class IPCChannel extends EventEmitter {
	private config: IPCChannelConfig
	private server: IPCServer | null = null
	private client: IPCClient | null = null
	private messageQueue: Map<string, IPCMessage[]> = new Map()
	private messageHandlers: Map<string, (msg: IPCMessage) => void> = new Map()
	private pendingMessages: Map<
		string,
		{ resolve: (msg: IPCMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	> = new Map()
	private bridgeOrchestrator: BridgeOrchestrator | null = null
	private remoteWorkers: Set<string> = new Set()
	private isServer: boolean = false
	private messageCount: number = 0

	constructor(config: Partial<IPCChannelConfig> = {}) {
		super()
		this.config = {
			port: config.port ?? 0,
			maxQueueSize: config.maxQueueSize ?? 1000,
			messageTimeout: config.messageTimeout ?? 5000,
			enableRemoteFallback: config.enableRemoteFallback ?? true,
			maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
			reconnectDelay: config.reconnectDelay ?? 1000,
		}
	}

	/**
	 * Start IPC server (for orchestrator)
	 */
	async startServer(): Promise<number> {
		this.server = new IPCServer()
		this.isServer = true

		this.server.on("message", (msg: IPCMessage) => {
			this.handleMessage(msg)
		})

		this.server.on("client-connected", (clientId: string) => {
			this.emit("worker-connected", clientId)
		})

		this.server.on("client-disconnected", (clientId: string) => {
			this.emit("worker-disconnected", clientId)
		})

		this.server.on("error", (error: any) => {
			this.emit("error", error)
		})

		const port = await this.server.start(this.config.port)
		this.config.port = port
		return port
	}

	/**
	 * Connect as client (for workers)
	 */
	async connect(port: number): Promise<void> {
		this.client = new IPCClient(port, this.config.maxReconnectAttempts, this.config.reconnectDelay)

		this.client.on("message", (msg: IPCMessage) => {
			this.handleMessage(msg)
		})

		this.client.on("connected", () => {
			this.emit("connected")
		})

		this.client.on("disconnected", () => {
			this.emit("disconnected")
		})

		this.client.on("reconnect-failed", () => {
			this.emit("reconnect-failed")
		})

		this.client.on("error", (error: any) => {
			this.emit("error", error)
		})

		await this.client.connect()
	}

	/**
	 * Start IPC (legacy method - starts server)
	 */
	async start(): Promise<void> {
		await this.startServer()
	}

	/**
	 * Handle received message
	 */
	private handleMessage(message: IPCMessage): void {
		// Check for pending message responses
		if (message.correlationId) {
			const pending = this.pendingMessages.get(message.correlationId)
			if (pending) {
				clearTimeout(pending.timer)
				this.pendingMessages.delete(message.correlationId)
				pending.resolve(message)
				return
			}
		}

		// Add to queue for destination
		const queue = this.messageQueue.get(message.to) || []

		if (queue.length >= this.config.maxQueueSize) {
			queue.shift() // Remove oldest message
		}

		queue.push(message)
		this.messageQueue.set(message.to, queue)

		// Emit message event
		this.emit("message", message)

		// Call registered handler
		const handler = this.messageHandlers.get(message.type)
		if (handler) {
			handler(message)
		}
	}

	/**
	 * Send message to destination
	 *
	 * @param message - IPC message to send
	 * @returns Promise resolving when message is sent
	 */
	async send<T>(message: Omit<IPCMessage<T>, "id" | "timestamp">): Promise<void> {
		const fullMessage: IPCMessage<T> = {
			...message,
			id: `msg-${++this.messageCount}-${Date.now()}`,
			timestamp: Date.now(),
		}

		// Check if destination is remote
		if (this.config.enableRemoteFallback && this.remoteWorkers.has(message.to)) {
			return this.sendViaBridge(fullMessage)
		}

		// Try local IPC first
		const sent = this.sendLocal(fullMessage)

		// Fallback to bridge if local fails
		if (!sent && this.config.enableRemoteFallback) {
			this.remoteWorkers.add(message.to)
			return this.sendViaBridge(fullMessage)
		}

		if (!sent) {
			throw new Error(`Failed to send message to ${message.to}`)
		}
	}

	/**
	 * Send message via local IPC
	 */
	private sendLocal(message: IPCMessage): boolean {
		if (this.isServer && this.server) {
			return this.server.send(message.to, message)
		} else if (this.client) {
			return this.client.send(message)
		}
		return false
	}

	/**
	 * Send message via BridgeOrchestrator (remote fallback)
	 */
	private async sendViaBridge(message: IPCMessage): Promise<void> {
		if (!this.bridgeOrchestrator) {
			this.bridgeOrchestrator = BridgeOrchestrator.getInstance()
		}

		if (!this.bridgeOrchestrator) {
			throw new Error("BridgeOrchestrator not available for remote fallback")
		}

		// BridgeOrchestrator integration would go here
		// For now, emit an event so the orchestrator can handle it
		this.emit("remote-message", message)
	}

	/**
	 * Wait for message matching criteria
	 *
	 * @param filter - Message filter function
	 * @param timeout - Optional timeout in milliseconds
	 * @returns Promise resolving to matching message
	 */
	async waitForMessage<T>(filter: (msg: IPCMessage) => boolean, timeout?: number): Promise<IPCMessage<T>> {
		// Check existing queue first
		for (const [destination, queue] of this.messageQueue.entries()) {
			const index = queue.findIndex(filter)
			if (index >= 0) {
				const message = queue.splice(index, 1)[0]
				return message as IPCMessage<T>
			}
		}

		// Wait for new message
		return new Promise((resolve, reject) => {
			const timeoutMs = timeout ?? this.config.messageTimeout
			const correlationId = `wait-${Date.now()}-${Math.random()}`

			const timer = setTimeout(() => {
				this.pendingMessages.delete(correlationId)
				reject(new Error("Message wait timeout"))
			}, timeoutMs)

			const handler = (msg: IPCMessage) => {
				if (filter(msg)) {
					clearTimeout(timer)
					this.removeListener("message", handler)
					this.pendingMessages.delete(correlationId)
					resolve(msg as IPCMessage<T>)
				}
			}

			this.on("message", handler)
			this.pendingMessages.set(correlationId, { resolve: resolve as any, reject, timer })
		})
	}

	/**
	 * Register message handler
	 */
	override on(event: "message", handler: (msg: IPCMessage) => void): this
	override on(event: string, handler: (...args: any[]) => void): this {
		if (event === "message") {
			// Store handler for specific message type processing
			return super.on(event, handler)
		}
		return super.on(event, handler)
	}

	/**
	 * Register handler for specific message type
	 */
	onMessageType(type: IPCMessageType, handler: (msg: IPCMessage) => void): void {
		this.messageHandlers.set(type, handler)
	}

	/**
	 * Mark worker as remote (use bridge for communication)
	 */
	markWorkerRemote(workerId: string): void {
		this.remoteWorkers.add(workerId)
	}

	/**
	 * Stop IPC server and clean up
	 */
	async stop(): Promise<void> {
		// Clear timers
		for (const { timer } of this.pendingMessages.values()) {
			clearTimeout(timer)
		}
		this.pendingMessages.clear()

		// Stop server or client
		if (this.server) {
			await this.server.stop()
			this.server = null
		}

		if (this.client) {
			this.client.disconnect()
			this.client = null
		}

		this.messageQueue.clear()
		this.messageHandlers.clear()
		this.remoteWorkers.clear()
		this.removeAllListeners()
	}

	/**
	 * Dispose of channel resources
	 */
	dispose(): void {
		this.messageQueue.clear()
		this.messageHandlers.clear()
		this.remoteWorkers.clear()
		this.pendingMessages.clear()
	}

	/**
	 * Get current port (for server mode)
	 */
	getPort(): number {
		return this.server?.getPort() ?? this.config.port
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		if (this.isServer) {
			return this.server?.isListening() ?? false
		}
		return this.client?.getConnectionStatus() ?? false
	}
}
