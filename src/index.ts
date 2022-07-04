import { CWLogInterface } from './CloudWatch/CloudWatchLogInterface';

(async () => {
  const logInterface = await (new CWLogInterface({
    key: process.env.AWS_KEY || '',
    keySecret: process.env.AWS_KEY_SECRET || '',
    role: process.env.AWS_ROLE || '',
    region: 'eu-central-1',
  })).Init();

  for await (const log of logInterface.getAPILogs(new Date(2022, 5, 1), new Date(2022, 5, 2))) {
    console.log(log);
  }

  for await (const log of logInterface.getTaskExecutionLogs('bior-fitbit-sync-task', '5b0cfe0f-859d-4d4d-afef-ce96731553c5', new Date('2022-06-25T18:20:04.827Z'), new Date('2022-06-25T18:20:10.219Z'))) {
    console.log(log);
  }
})().catch(err => { console.log(err); });
