import AWS, { CloudWatch } from 'aws-sdk';
import { Log, LogInterface } from '../types';

interface AWSCredentials {
  key: string;
  keySecret: string;
  role: string;
  region: string;
}

class CWLogInterface implements LogInterface {
  private credentials: AWSCredentials;

  private streamDriver = new CWLogStreamDriver();

  private insightDriver = new CWLogInsightDriver();

  constructor(credentials: AWSCredentials) {
    this.credentials = credentials;
  }

  async Init(): Promise<void> {
    AWS.config.region = this.credentials.region;
    AWS.config.credentials = new AWS.Credentials(this.credentials.key, this.credentials.keySecret);
    const sts = new AWS.STS();
    return new Promise<void>((res, rej) => {
      sts.assumeRole({
        RoleArn: this.credentials.role,
        RoleSessionName: 'awssdk',
      }, (err, data) => {
        if (err) { // an error occurred
          rej(err);
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

  async getAPILogs(logGroup: string, from: Date, till: Date): Promise<Log[]> {
    return [];
  }

  async getTaskLogs(task: string, from: Date, till: Date): Promise<Log[]> {
    return [];
  }

  async getTaskExecutionLogs(task: string, executionId: string, from: Date, to: Date): Promise<Log[]> {
    return [];
  }
}
