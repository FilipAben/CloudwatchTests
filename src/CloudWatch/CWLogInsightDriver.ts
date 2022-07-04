import AWS from 'aws-sdk';
import { GetQueryResultsResponse, ResultRows } from 'aws-sdk/clients/cloudwatchlogs';
import { Log } from '../types';

type Epoch = number;

export class CWLogInsightDriver {
  private window: number;

  private dynamicWindow = true;

  private log: AWS.CloudWatchLogs;

  callLog: number[] = [];

  constructor(log: AWS.CloudWatchLogs, startWindow: number, dynamic = true) {
    this.log = log;
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

  async #queryAndFetch(logGroup: string, query: string, from: Epoch, to: Epoch): Promise<GetQueryResultsResponse> {
    return new Promise((res, rej) => {
      const start = new Date().getTime();
      this.log.startQuery({
        logGroupName: logGroup,
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
  #recordToLog(record: ResultRows): Log {
    const result:Log = { timestamp: new Date(), message: '', context: {} };

    for (const r of record) {
      if (r.field === undefined) {
        continue;
      }
      if (r.field === '@timestamp') {
        result.timestamp = new Date(`${r.value?.split(' ').join('T')}Z`);
      } else if (r.field === '@message') {
        result.message = r.value || '';
      } else {
        result.context[r.field as string] = r.value;
      }
    }
    return result;
  }

  async* getQueryLogs(logGroup: string, query: string, from: Date, to: Date): AsyncGenerator<Log> {
    let startWindow = from.getTime();
    let lastPtr: string|null = null;

    while (startWindow < to.getTime()) {
      const windowResult = await this.#queryAndFetch(
        logGroup,
        'fields @timestamp, @message | sort @timestamp asc',
        startWindow,
        Math.min(to.getTime(), startWindow + this.window * 1000)
      );
      if (windowResult.results?.length) {
        /* Convert to log line */
        const logs = windowResult.results.map(r => this.#recordToLog(r));

        /* remove duplicates by checking the @ptr value */
        if (lastPtr !== null) {
          // eslint-disable-next-line no-loop-func
          const idx = logs.findIndex(log => log.context['@ptr'] && log.context['@ptr'] === lastPtr);
          if (idx !== undefined) {
            logs.splice(0, idx + 1);
          }
        }
        lastPtr = logs[logs.length - 1].context['@ptr'];

        /* yield results */
        for (const log of logs) {
          yield log;
        }
        const numResults = logs.length;
        try {
          const firstTs = logs[0].timestamp.getTime() / 1000;
          const lastTs = logs[numResults - 1].timestamp.getTime() / 1000;
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
  }

  getAllLogs(logGroup: string, from: Date, to: Date, _useDayPrefix?: boolean): AsyncGenerator<Log> {
    return this.getQueryLogs(logGroup, 'fields @timestamp, @message | sort @timestamp asc', from, to);
  }

  getRequestLogs(logGroup: string, requestId: string, from: Date, to: Date): AsyncGenerator<Log> {
    return this.getQueryLogs(logGroup, `fields @timestamp, @message
      | filter @requestId = "${requestId}"
      | sort @timestamp asc`, from, to);
  }
}
