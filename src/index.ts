import { CWLogInterface } from './CloudWatch/CloudWatchLogInterface';

(async () => {
  const logInterface = await (new CWLogInterface({
    key: process.env.AWS_KEY || '',
    keySecret: process.env.AWS_KEY_SECRET || '',
    role: process.env.AWS_ROLE || '',
    region: 'eu-central-1',
  })).Init();

  console.log('before query logs');
  for await (const log of logInterface.getTaskLogs('bior-fitbit-sync-task', new Date(2022, 5, 1), new Date(2022, 5, 2))) {
    console.log(log);
  }
  console.log('after query logs');
})().catch(err => { console.log(err); });
