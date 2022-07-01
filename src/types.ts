export interface LogInterface {
  getAPILogs(logGroup: string, from: Date, till: Date): Promise<Log[]>;
  getTaskLogs(task: string, from: Date, till: Date): Promise<Log[]>;
  getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): Promise<Log[]>;
}

export interface Log {
  timestamp: Date;
  message: string;
  context: Record<string, any>;
}
