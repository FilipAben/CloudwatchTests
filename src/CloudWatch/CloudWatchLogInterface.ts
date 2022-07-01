import AWS, { CloudWatch } from 'aws-sdk';
import { Log, LogInterface } from '../types';
import { CWLogInsightDriver } from './CWLogInsightDriver';

export interface AWSCredentials {
  key: string;
  keySecret: string;
  role: string;
  region: string;
}

export class CWLogInterface implements LogInterface {
  private credentials: AWSCredentials;

  private logs: AWS.CloudWatchLogs;

  private insightDriver: CWLogInsightDriver;

  private APILogGroup = '';

  constructor(credentials: AWSCredentials) {
    this.credentials = credentials;
    this.logs = new AWS.CloudWatchLogs();
    this.insightDriver = new CWLogInsightDriver(this.logs, 3600, true);
  }

  async Init(): Promise<CWLogInterface> {
    AWS.config.region = this.credentials.region;
    AWS.config.credentials = new AWS.Credentials(this.credentials.key, this.credentials.keySecret);
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
          res(this);
          // this.#findLogGroups()
          //   .then(() => {
          //     res(this);
          //   })
          //   .catch(flgError => rej(flgError));
        }
      });
    });
  }

  async #getLogGroupList(): Promise<string[]> {
    const groups:string[] = [];

    const singleCall = async (nextToken?: string) => new Promise((res, rej) => {
      this.logs.describeLogGroups({
        limit: 1000,
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
      console.log(data);
      // groups.push(...data.logStreams);
      token = data.nextToken;
    } while (token);

    return groups;
  }

  async #findLogGroups() {
    const groups = await this.#getLogGroupList();
    console.log(groups);
  }

  getAPILogs(from: Date, to: Date): AsyncGenerator<Log> {
    return this.insightDriver.getAllLogs(this.APILogGroup, from, to);
  }

  getTaskLogs(task: string, from: Date, to: Date): AsyncGenerator<Log> {
    return this.insightDriver.getAllLogs(`/aws/lambda/${task}`, from, to);
  }

  getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): AsyncGenerator<Log> {
    return this.insightDriver.getRequestLogs(`/aws/lambda/${task}`, executionId, from, to);
  }
}
