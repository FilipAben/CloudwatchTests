// eslint-disable-next-line max-classes-per-file
import AWS from 'aws-sdk';
import { LogStream, LogStreams, OutputLogEvent, OutputLogEvents } from 'aws-sdk/clients/cloudwatchlogs';
import { eachDayOfInterval, format, getOverlappingDaysInIntervals } from 'date-fns';

const WINDOW_SIZE = 900;

const env = ['AWS_KEY', 'AWS_KEY_SECRET', 'AWS_ROLE'];

env.forEach(e => {
  if (!process.env[e]) {
    throw new Error(`Environment variable ${e} not defined! Need ${env.join(', ')}`);
  }
});

function authenticateAWS() {
  AWS.config.region = 'eu-central-1';
  AWS.config.credentials = new AWS.Credentials(process.env.AWS_KEY || '', process.env.AWS_KEY_SECRET || '');
  const sts = new AWS.STS();
  return new Promise<void>((res, rej) => {
    sts.assumeRole({
      RoleArn: process.env.AWS_ROLE || '',
      RoleSessionName: 'awssdk',
    }, (err, data) => {
      if (err) { // an error occurred
        console.log('Cannot assume role');
        console.log(err, err.stack);
        rej();
      } else { // successful response
        AWS.config.update({
          accessKeyId: data.Credentials?.AccessKeyId,
          secretAccessKey: data.Credentials?.SecretAccessKey,
          sessionToken: data.Credentials?.SessionToken,
        });
        res();
      }
    });
  });
}

class AWSLogDriver {
  logGroup: string;

  cloudWatch: AWS.CloudWatchLogs = new AWS.CloudWatchLogs();

  calls: Date[] = [];

  refCount = 0;

  constructor(logGroup: string) {
    this.logGroup = logGroup;
  }

  #startCall() {
    this.refCount += 1;
    this.calls.push(new Date());
  }

  #stopCall() {
    this.refCount -= 1;
  }

  async* GetAWSLogEvents(stream: LogStream, from: Date, till: Date): AsyncGenerator<OutputLogEvent> {
    const singleCall = async (nextToken?: string) => new Promise((res, rej) => {
      this.#startCall();
      this.cloudWatch.getLogEvents({
        logGroupName: this.logGroup,
        logStreamName: stream.logStreamName || '',
        startTime: from.getTime(),
        endTime: till.getTime(),
        nextToken,
      }, async (err, data) => {
        this.#stopCall();
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

  async GetAWSLogStreamsWithPrefix(prefix: string): Promise<LogStreams> {
    const streams = [];

    const singleCall = async (nextToken?: string) => new Promise((res, rej) => {
      this.#startCall();
      this.cloudWatch.describeLogStreams({
        logGroupName: this.logGroup,
        logStreamNamePrefix: prefix,
        nextToken,
      }, async (err: any, data: any) => {
        this.#stopCall();
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
}

class ExhLogStream {
  exhausted = false;

  stream: LogStream;

  driver: AWSLogDriver;

  generator: AsyncGenerator<OutputLogEvent> | null = null;

  start: Date;

  end: Date;

  holdValue: OutputLogEvent | null = null;

  constructor(stream: LogStream, driver: AWSLogDriver, start: Date, end: Date) {
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
      this.generator = this.driver.GetAWSLogEvents(this.stream, this.start, this.end);
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

class LogInterface {
  driver: AWSLogDriver;

  constructor(logGroup: string) {
    this.driver = new AWSLogDriver(logGroup);
  }

  async GetAllLogStreams(from: Date, till: Date): Promise<ExhLogStream[]> {
    const days = eachDayOfInterval({ start: from, end: till });
    const resultStreams: ExhLogStream[] = [];

    for (const day of days) {
      const streams = await this.driver.GetAWSLogStreamsWithPrefix(format(day, 'yyyy/MM/dd'));
      for (const stream of streams) {
        if (!stream.firstEventTimestamp || !stream.lastEventTimestamp) {
          continue;
        }
        if (stream.firstEventTimestamp < till.getTime() && stream.lastEventTimestamp > from.getTime()) {
          resultStreams.push(new ExhLogStream(stream, this.driver, from, till));
        }
      }
    }
    return resultStreams;
  }

  // eslint-disable-next-line class-methods-use-this
  selectStreams(streams: ExhLogStream[], windowStart: number, windowEnd: number) {
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

  async* GetLogs(from: Date, till: Date): AsyncGenerator<OutputLogEvents> {
    console.time('Get streams');
    const streams = await this.GetAllLogStreams(from, till);
    console.timeEnd('Get streams');
    let windowStart = from.getTime();
    let windowEnd = from.getTime() + WINDOW_SIZE * 1000;
    let logs: OutputLogEvents = [];

    let windowStreams = this.selectStreams(streams, windowStart, windowEnd);

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
          yield logs;
        }
        logs = [];
        windowStart = windowEnd;
        windowEnd = windowStart + WINDOW_SIZE * 1000;
        windowStreams = this.selectStreams(streams, windowStart, windowEnd);
      }
    }
  }

  async GetRequestLogs(requestId: string, from: Date, till: Date) {
    let streams = await this.GetAllLogStreams(from, till);
    let done = false;
    let streamfound = false;
    const allResults: OutputLogEvents = [];

    while (!done) {
      const reqs = streams.map(w => w.next());
      const results = ((await Promise.all(reqs)).filter(r => r !== null) as OutputLogEvents);
      if (results.length === 0) {
        done = true;
      }
      if (!streamfound) {
        const reqStream = results.findIndex(r => r.message && r.message.indexOf(requestId) !== -1);
        if (reqStream !== undefined) {
          streams = [streams[reqStream]];
          allResults.push(results[reqStream]);
          streamfound = true;
        }
      } else {
        allResults.push(...results);
      }
    }
    return allResults;
  }

  GetCalls(): Date[] {
    return this.driver.calls;
  }
}

async function getLogs(logGroup: string, from: Date, to: Date) {
  let totalTicks = 0;
  let concurrentSum = 0;
  const log = new LogInterface(logGroup);
  let logCount = 0;

  const intervalHandle = setInterval(() => {
    totalTicks += 1;
    concurrentSum += log.driver.refCount;
  }, 1000);
  console.time('Total execution');
  for await (const l of log.GetLogs(new Date(2022, 5, 20, 9, 0, 0), new Date(2022, 5, 20, 9, 15, 0))) {
    logCount += l.length;
  }

  console.timeEnd('Total execution');
  console.log(logCount, ' loglines');
  console.log(log.GetCalls().length, ' calls');
  console.log('Average concurrent calls:', Math.round((concurrentSum / totalTicks) * 100) / 100);
  clearInterval(intervalHandle);
}

async function getRequestLogs(logGroup: string, requestId: string, from: Date, to: Date) {
  const logs = new LogInterface(logGroup);

  console.time('exec');
  const data = await logs.GetRequestLogs('5b0cfe0f-859d-4d4d-afef-ce96731553c5', new Date('2022-06-25T18:20:04.827Z'), new Date('2022-06-25T18:20:10.219Z'));
  console.timeEnd('exec');
}

(async () => {
  await authenticateAWS();
  // await getLogs('/aws/lambda/bior-fitbit-sync-task', new Date(2022, 5, 20, 9, 0, 0), new Date(2022, 5, 20, 9, 15, 0));
  await getRequestLogs('/aws/lambda/bior-fitbit-sync-task', '5b0cfe0f-859d-4d4d-afef-ce96731553c5', new Date('2022-06-25T18:20:04.827Z'), new Date('2022-06-25T18:20:10.219Z'));
})().catch(() => {});
