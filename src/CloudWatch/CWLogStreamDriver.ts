// eslint-disable-next-line max-classes-per-file
import CloudWatchLogs, { LogStream, LogStreams, OutputLogEvent, OutputLogEvents } from 'aws-sdk/clients/cloudwatchlogs';
import { eachDayOfInterval, format } from 'date-fns';
import { Log } from '../types';

class ExhLogStream {
  exhausted = false;

  stream: LogStream;

  driver: CWLogStreamDriver;

  logGroup: string;

  generator: AsyncGenerator<OutputLogEvent> | null = null;

  start: Date;

  end: Date;

  holdValue: OutputLogEvent | null = null;

  constructor(logGroup: string, stream: LogStream, driver: CWLogStreamDriver, start: Date, end: Date) {
    this.logGroup = logGroup;
    this.stream = stream;
    this.driver = driver;
    this.start = start;
    this.end = end;
  }

  first(): number {
    return this.stream.firstEventTimestamp || 0;
  }

  last(): number {
    return this.stream.lastEventTimestamp || 0;
  }

  isExhausted(): boolean {
    return this.exhausted;
  }

  async next(maxTs?: number): Promise<OutputLogEvent | null> {
    if (this.exhausted) {
      return null;
    }
    if (this.generator === null) {
      this.generator = this.driver.GetAWSLogEvents(this.logGroup, this.stream, this.start, this.end);
    }
    if (this.holdValue === null) {
      const result = await this.generator.next();
      if (result.done) {
        this.exhausted = true;
        return null;
      }
      this.holdValue = result.value;
    }

    if (!this.holdValue.timestamp || (maxTs !== undefined && (this.holdValue.timestamp > maxTs))) {
      return null;
    }
    const tmp = this.holdValue;
    this.holdValue = null;
    return tmp;
  }
}

export class CWLogStreamDriver {
  private log: CloudWatchLogs;

  private window: number;

  constructor(log: CloudWatchLogs, window: number) {
    this.log = log;
    this.window = window;
  }

  async #GetAWSLogStreams(logGroup: string, prefix?: string): Promise<LogStreams> {
    const streams = [];

    const singleCall = async (nextToken?: string) => new Promise((res, rej) => {
      this.log.describeLogStreams({
        logGroupName: logGroup,
        logStreamNamePrefix: prefix,
        nextToken,
      }, async (err: any, data: any) => {
        if (err) {
          console.log(err);
          rej(err);
          return;
        }
        res(data);
      });
    });
    let data: any = null;
    let token: string | undefined;
    do {
      data = await singleCall(token);
      streams.push(...data.logStreams);
      token = data.nextToken;
    } while (token);

    return streams;
  }

  // eslint-disable-next-line class-methods-use-this
  #selectStreams(streams: ExhLogStream[], windowStart: number, windowEnd: number) {
    const selection = [];
    for (const stream of streams) {
      if (stream.last() > windowStart && stream.first() < windowEnd) {
        selection.push(stream);
      }
    }
    return selection
      .filter(s => !s.isExhausted()) // filter out exhausted streams
      .sort((a, b) => a.first() - b.last()); // sort streams first to last
  }

  // eslint-disable-next-line class-methods-use-this
  #recordToLog(input: OutputLogEvent): Log {
    return {
      timestamp: new Date(input.timestamp || 0),
      message: input.message || 'unknown',
      context: {},
    };
  }

  async* GetAWSLogEvents(logGroup: string, stream: LogStream, from: Date, till: Date): AsyncGenerator<OutputLogEvent> {
    const singleCall = async (nextToken?: string) => new Promise((res, rej) => {
      this.log.getLogEvents({
        logGroupName: logGroup,
        logStreamName: stream.logStreamName || '',
        startTime: from.getTime(),
        endTime: till.getTime(),
        nextToken,
      }, async (err, data) => {
        if (err) {
          console.log(err);
          rej(err);
          return;
        }
        res(data);
      });
    });
    let oldToken;
    let data: any = { nextForwardToken: null };
    let prom = singleCall();
    do {
      oldToken = data.nextForwardToken;
      data = await prom;
      if (data.events) {
        for (const [i, e] of data.events.entries()) {
          if (i === data.events.length - 1) {
            prom = singleCall(data.nextForwardToken);
          }
          yield e;
        }
      }
    } while (data.nextForwardToken !== oldToken);
    await prom;
  }

  async GetAllLogStreams(logGroup: string, from: Date, till: Date, withDayPrefix = false): Promise<ExhLogStream[]> {
    const days = eachDayOfInterval({ start: from, end: till });
    const resultStreams: ExhLogStream[] = [];

    for (const day of days) {
      const streams = await this.#GetAWSLogStreams(logGroup, withDayPrefix ? format(day, 'yyyy/MM/dd') : undefined);
      for (const stream of streams) {
        if (!stream.firstEventTimestamp || !stream.lastEventTimestamp) {
          continue;
        }
        if (stream.firstEventTimestamp < till.getTime() && stream.lastEventTimestamp > from.getTime()) {
          resultStreams.push(new ExhLogStream(logGroup, stream, this, from, till));
        }
      }
    }
    return resultStreams;
  }

  async* getAllLogs(logGroup: string, from: Date, till: Date, useDayPrefix = false): AsyncGenerator<Log> {
    const streams = await this.GetAllLogStreams(logGroup, from, till, useDayPrefix);
    let windowStart = from.getTime();
    let windowEnd = from.getTime() + this.window * 1000;
    let logs: OutputLogEvents = [];

    let windowStreams = this.#selectStreams(streams, windowStart, windowEnd);

    while (windowStart < till.getTime()) {
      const we = windowEnd;
      const reqs = windowStreams.map(w => w.next(we));
      const results = ((await Promise.all(reqs)).filter(r => r !== null) as OutputLogEvents);
      if (results.length) {
        logs.push(...results);
      } else {
        // Sort, yield & advance window
        if (logs.length) {
          logs = logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          for (const logLine of logs) {
            yield this.#recordToLog(logLine);
          }
        }
        logs = [];
        windowStart = windowEnd;
        windowEnd = windowStart + this.window * 1000;
        windowStreams = this.#selectStreams(streams, windowStart, windowEnd);
      }
    }
  }

  async* getRequestLogs(logGroup: string, requestId: string, from: Date, till: Date): AsyncGenerator<Log> {
    const streams = await this.GetAllLogStreams(logGroup, from, till, true);
    let requestStream = null;

    /* First hunt for the stream which contains the requestId logging */
    for (;;) {
      const reqs = streams.map(w => w.next());
      const results = ((await Promise.all(reqs)).filter(r => r !== null) as OutputLogEvents);
      if (results.length === 0) {
        return;
      }
      const reqStreamId = results.findIndex(r => r.message && r.message.indexOf(requestId) !== -1);
      if (reqStreamId !== undefined) {
        /* Found it */
        requestStream = streams[reqStreamId];
        yield this.#recordToLog(results[reqStreamId]);
        break;
      }
    }

    /* Then query the hell out of it */
    for (;;) {
      const result = await requestStream.next();
      if (result === null) {
        return;
      }

      if (result.message && result.message.indexOf(requestId) !== -1) {
        yield this.#recordToLog(result);
      }
    }
  }
}
