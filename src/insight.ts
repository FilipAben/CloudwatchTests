import AWS from 'aws-sdk';
import { GetQueryResultsResponse, ResultRows } from 'aws-sdk/clients/cloudwatchlogs';
import { parse } from 'date-fns';

type Epoch = number;

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

class InsightLog {
  private window: number;

  private dynamicWindow = true;

  private log: AWS.CloudWatchLogs = new AWS.CloudWatchLogs();

  callLog: number[] = [];

  constructor(startWindow: number, dynamic = true) {
    this.window = startWindow;
    this.dynamicWindow = dynamic;
  }

  async #fetchResults(queryId: string): Promise<GetQueryResultsResponse | null> {
    return new Promise((res, rej) => {
      this.log.getQueryResults({ queryId }, (err, data) => {
        if (err) {
          console.log('Get query results', err);
          rej(err);
          return;
        }
        if (data.status !== 'Complete') {
          res(null);
          return;
        }
        res(data);
      });
    });
  }

  async #query(logGroup: string, query: string, from: Epoch, to: Epoch): Promise<GetQueryResultsResponse> {
    return new Promise((res, rej) => {
      const start = new Date().getTime();
      this.log.startQuery({
        logGroupName: '/aws/lambda/bior-fitbit-sync-task',
        startTime: from,
        endTime: to,
        limit: 10000,
        queryString: query,
      }, async (err, data) => {
        if (err) {
          console.log(err);
          rej(err);
          return;
        }
        if (data.queryId) {
          while (true) {
            const result = await this.#fetchResults(data.queryId);
            if (result !== null) {
              this.callLog.push(new Date().getTime() - start);
              res(result);
              return;
            }
          }
        } else {
          console.log('No query id in data?');
          rej(new Error('No query ID in data'));
        }
      });
    });
  }

  // eslint-disable-next-line class-methods-use-this
  #recordToObject(record: ResultRows): Record<string, any> {
    const result:Record<string, any> = {};

    for (const r of record) {
      if (r.field === undefined) {
        continue;
      }
      result[r.field as string] = r.value;
    }
    return result;
  }

  async getLogs(logGroup: string, from: Date, to: Date) {
    let startWindow = from.getTime();
    const result = [];

    while (startWindow < to.getTime()) {
      const windowResult = await this.#query(logGroup, `fields @timestamp, @message
      | sort @timestamp asc`, startWindow, Math.min(to.getTime(), startWindow + this.window * 1000));
      result.push(windowResult);
      if (windowResult.results) {
        const numResults = windowResult.results.length;
        console.log('startWindow =', new Date(startWindow), ', window size =', this.window, ', results =', numResults);
        try {
          const firstTs = new Date(`${this.#recordToObject(windowResult.results[0])['@timestamp'].split(' ').join('T')}Z`).getTime() / 1000;
          const lastTs = new Date(`${this.#recordToObject(windowResult.results[numResults - 1])['@timestamp'].split(' ').join('T')}Z`).getTime() / 1000;
          console.log('\t result window =', Math.round((lastTs - firstTs) * 100) / 100, 's');
          if (!this.dynamicWindow) {
            if (numResults === 10000) {
              startWindow = lastTs * 1000;
            } else {
              startWindow += this.window * 1000;
            }
            continue;
          }
          if (numResults === 10000) {
            if ((lastTs - firstTs) < this.window * 0.9) {
              /* Window too large: reduce window by half the different of the logged interval, pick up from last timestamp */
              this.window -= (this.window - (lastTs - firstTs)) / 2;
              startWindow = lastTs * 1000;
            } else {
              startWindow = lastTs * 1000;
            }
          } else if (numResults < 8000) {
            startWindow += this.window * 1000;
            /* Window too small: enlarge window by ratio of returned results */
            this.window *= 10000 / (numResults + ((10000 - numResults) / 2));
          } else {
            startWindow += this.window * 1000;
          }
        } catch (err) {
          console.log('Failed to parse timestamps');
        }
      }
    }
    return result;
  }

  async getRequestLogs(logGroup: string, requestId: string, from: Date, to: Date) {
    const result = await this.#query(logGroup, `fields @timestamp, @message
      | filter @requestId = "${requestId}"
      | sort @timestamp asc`, from.getTime(), to.getTime());

    console.log(result);
    return result;
  }
}

async function getLogsExample() {
  const logs = new InsightLog(900);
  let scanTotalBytes = 0;

  console.time('exec');
  const data = await logs.getLogs('/aws/lambda/bior-fitbit-sync-task', new Date(2022, 5, 20, 9, 0, 0), new Date(2022, 5, 20, 9, 15, 0));
  console.timeEnd('exec');

  for (const d of data) {
    scanTotalBytes += (d.statistics?.bytesScanned || 0);
  }

  console.log('Total GB scanned:', Math.round((scanTotalBytes / 1024 / 1024 / 1024) * 100) / 100);
  console.log('Number of calls', logs.callLog.length);
  console.log('Average call duration:', Math.round((logs.callLog.reduce((prev, curr) => prev + curr, 0) / 1000 / logs.callLog.length) * 100) / 100, 's');
}

async function getRequestIdExample() {
  const logs = new InsightLog(900);

  console.time('exec');
  const data = await logs.getRequestLogs('/aws/lambda/bior-fitbit-sync-task', '5b0cfe0f-859d-4d4d-afef-ce96731553c5', new Date('2022-06-25T18:20:04.827Z'), new Date('2022-06-25T18:20:10.219Z'));
  console.timeEnd('exec');

  if (data.statistics?.bytesScanned) {
    console.log('MB Scanned:', data.statistics.bytesScanned / 1024 / 1024);
  }
}

(async () => {
  await authenticateAWS();
  await getRequestIdExample();
})().catch(() => {});
