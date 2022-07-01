export interface LogInterface {
  getAPILogs(from: Date, till: Date): AsyncGenerator<Log>;
  getTaskLogs(task: string, from: Date, till: Date): AsyncGenerator<Log>;
  getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): AsyncGenerator<Log>;
}

export interface Log {
  timestamp: Date;
  message: string;
  context: Record<string, any>;
}
