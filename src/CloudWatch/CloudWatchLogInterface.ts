import AWS from 'aws-sdk';
import { DescribeLogGroupsResponse, LogGroups } from 'aws-sdk/clients/cloudwatchlogs';
import { APILog, Log, LogInterface } from '../types';
import { CWLogInsightDriver } from './CWLogInsightDriver';
import { CWLogStreamDriver } from './CWLogStreamDriver';

export interface AWSCredentials {
  key: string;
  keySecret: string;
  role: string;
  region: string;
}

export class CWLogInterface implements LogInterface {
  private credentials: AWSCredentials;

  private logs: AWS.CloudWatchLogs | null = null;

  private insightDriver: CWLogInsightDriver | null = null;

  private streamDriver: CWLogStreamDriver | null = null;

  private APILogGroup = '';

  // eslint-disable-next-line max-len
  private APILogRegex = /^\[.*\] (?<httpStatus>\d+) (?<duration>\S+) (?<applicationId>\w*) (?<userId>\w+) (?<userAddress>\S+) (?<host>\S+) "(?<request>.+)" (?<upstreamAddress>\S+) (?<bodySize>\d+) "(?<userAgent>.+)"/;

  constructor(credentials: AWSCredentials) {
    this.credentials = credentials;
    AWS.config.region = this.credentials.region;
    AWS.config.credentials = new AWS.Credentials(this.credentials.key, this.credentials.keySecret);
  }

  async Init(): Promise<CWLogInterface> {
    const sts = new AWS.STS();
    return new Promise<CWLogInterface>((res, rej) => {
      sts.assumeRole({
        RoleArn: this.credentials.role,
        RoleSessionName: 'awssdk',
      }, (err, data) => {
        if (err) {
          rej(err);
        } else {
          AWS.config.update({
            accessKeyId: data.Credentials?.AccessKeyId,
            secretAccessKey: data.Credentials?.SecretAccessKey,
            sessionToken: data.Credentials?.SessionToken,
          });
          this.logs = new AWS.CloudWatchLogs();
          this.insightDriver = new CWLogInsightDriver(this.logs, 3600, true);
          this.streamDriver = new CWLogStreamDriver(this.logs, 3600);

          this.#findLogGroups()
            .then(() => {
              res(this);
            })
            .catch(flgError => rej(flgError));
        }
      });
    });
  }

  async #getLogGroupList(): Promise<LogGroups> {
    const groups:LogGroups = [];

    const singleCall = async (nextToken?: string) => new Promise<DescribeLogGroupsResponse>((res, rej) => {
      this.logs?.describeLogGroups({
        limit: 50,
        nextToken,
      }, async (err: any, data: DescribeLogGroupsResponse) => {
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
      groups.push(...data.logGroups);
      token = data.nextToken;
    } while (token);

    return groups;
  }

  async #findLogGroups(): Promise<void> {
    const groups = await this.#getLogGroupList();
    for (const group of groups) {
      if (group.logGroupName?.indexOf('-api-gateway') !== -1) {
        this.APILogGroup = group.logGroupName || '';
        return;
      }
    }
    throw new Error('Failed to find api gateway logs');
  }

  async* getAPILogs(from: Date, to: Date): AsyncGenerator<APILog> {
    if (!this.streamDriver) {
      throw new Error('Not initialized');
    }
    for await (const log of this.streamDriver.getAllLogs(this.APILogGroup, from, to)) {
      const match = this.APILogRegex.exec(log.message);
      if (match !== null) {
        yield ({ timestamp: log.timestamp,
          httpStatus: parseInt(match.groups?.httpStatus || '-1', 10),
          duration: parseFloat(match.groups?.duration || '-1'),
          userId: match.groups?.userId || 'unknown',
          userAddress: match.groups?.userAddress || 'unknown',
          host: match.groups?.host || 'unknown',
          request: match.groups?.request || 'unknown',
          upstreamAddress: match.groups?.upstreamAddress || 'unknown',
          bodySize: parseInt(match.groups?.bodySize || '-1', 10),
          userAgent: match.groups?.userAgent || 'unknown' });
      }
    }
  }

  getTaskLogs(task: string, from: Date, to: Date): AsyncGenerator<Log> {
    if (!this.insightDriver) {
      throw new Error('Not initialized');
    }

    return this.insightDriver.getAllLogs(`/aws/lambda/${task}`, from, to, true);
  }

  getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): AsyncGenerator<Log> {
    if (!this.insightDriver) {
      throw new Error('Not initialized');
    }
    return this.insightDriver.getRequestLogs(`/aws/lambda/${task}`, executionId, from, to);
  }
}
