interface LogDriver {
  getLogGroupLogs(logGroup: string, from: Date, till: Date);
  getTaskLogs(task: string, from: Date, till: Date);
}
