// SPDX-License-Identifier: MIT
import type {ObservationReference} from './page-types.ts';
import type {ValidateFunction} from 'ajv';
export type ClearActRisk = "read" | "write" | "high";
export type ClearActJsonObject = Record<string, unknown>;
export interface ClearActActionMetadata {
  name: string;
  description: string;
  /** JSON Schema writeOnly fields execute normally and are masked in operation records and visual hooks. */
  inputSchema: ClearActJsonObject;
  risk: ClearActRisk;
  resultMode?: "legacy" | "page";
  target?: string;
  title?: string;
}
export interface ClearActExecutionContext {
  operationId: string;
  executionToken?: string;
  intent: string;
  /** Cooperative cancellation; an aborted signal does not imply rollback. */
  signal: AbortSignal;
  /** Run once after this connection's successful result is acknowledged by the broker.
   * Use for native document navigation; never for a business write or retry.
   * Unavailable on transports without a broker acknowledgement. */
  afterResult?: (callback: () => void) => void;
}
export interface ClearActAction extends ClearActActionMetadata {
  execute(input: ClearActJsonObject, context: ClearActExecutionContext): Promise<unknown>;
}
export interface ClearActOperation {
  id: string;
  sessionId: string;
  action: string;
  arguments: ClearActJsonObject;
  intent: string;
  status:
    | "waiting_approval"
    | "queued"
    | "executing"
    | "succeeded"
    | "failed"
    | "rejected"
    | "cancelled";
  /** A stop was requested; a real in-flight result may still succeed. */
  cancelRequested?: boolean;
  observation?: ObservationReference;
  errorCode?: string;
  effect?: "not_started";
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ClearActEvent {
  type: "operation" | "connection" | "execution" | "control" | "interval";
  operationIntervalMs?: number;
  operation?: ClearActOperation;
  connected?: boolean;
  phase?: "preparing" | "executing" | "settled";
  enabled?: boolean;
}
export interface ClearActRuntimeOptions {
  sessionId: string;
  serverUrl: string;
  context?: ClearActJsonObject;
  contextMode?: "legacy" | "page";
  /** Minimum time between actual action starts, 0–5000ms. Actions always execute serially. Defaults to 500ms. */
  operationIntervalMs?: number;
  approvalToken?: string;
  /** Supply schema-matched build-time validators on pages whose CSP disallows dynamic compilation. Missing validators must throw. */
  validatorFactory?: (action: ClearActActionMetadata) => ValidateFunction;
}
