export interface LogInterface {
  getAPILogs(from: Date, till: Date): AsyncGenerator<APILog>;
  getTaskLogs(task: string, from: Date, till: Date): AsyncGenerator<Log>;
  getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): AsyncGenerator<Log>;
}

export interface Log {
  timestamp: Date;
  message: string;
  context: Record<string, any>;
}

export interface APILog {
  timestamp: Date;
  httpStatus: number;
  duration: number;
  userId: string;
  userAddress: string;
  host: string;
  request: string;
  upstreamAddress: string;
  bodySize: number;
  userAgent: string;
}
