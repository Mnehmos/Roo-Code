import { z } from "zod"

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	/** Flag indicating this task is part of parallel execution */
	parallelExecution: z.boolean().optional(),
	/** Workspace subdirectory assigned to this worker */
	workingDirectory: z.string().optional(),
	/** Worker specialization type (orchestrator, worker, reviewer) */
	workerType: z.string().optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
