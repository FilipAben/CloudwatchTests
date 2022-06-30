# Cloudwatch Tests

This repo contains example code to query ExtraHorizon Cloudwatch logs either through log streams or through log insights.

Pass auth info through the AWS_KEY & AWS_KEY_SECRET environment variables when running + the AWS role through AWS_ROLE.


Build: 
```
yarn install
yarn build
```

Run:
`node build/logstream.ts` or `node build/insight.ts`
